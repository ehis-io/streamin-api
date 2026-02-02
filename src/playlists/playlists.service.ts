import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import { TmdbService } from '../tmdb/tmdb.service';
import { MALService } from '../mal/mal.service';

@Injectable()
export class PlaylistsService {
    private readonly logger = new Logger(PlaylistsService.name);

    constructor(
        private prisma: PrismaService,
        private aiService: AiService,
        private tmdbService: TmdbService,
        private malService: MALService
    ) { }

    async generateFromPrompt(prompt: string) {
        const aiResponse = await this.aiService.generatePlaylist(prompt);
        if (!aiResponse) return { error: 'Failed to generate playlist' };

        // Create the playlist in DB
        const playlist = await this.prisma.playlist.create({
            data: {
                name: aiResponse.name,
                description: aiResponse.description,
            }
        });

        // Resolve items to TMDB/MAL IDs in parallel
        const resolvedItems = await Promise.all(
            aiResponse.items.map(async (item) => {
                let id: number | null = null;
                let posterPath: string | null = null;

                try {
                    if (item.type === 'anime') {
                        const searchResults = await this.malService.search(item.title);
                        if (searchResults && (searchResults as any).data?.length > 0) {
                            const topResult = (searchResults as any).data[0];
                            id = topResult.mal_id;
                            posterPath = topResult.images?.jpg?.large_image_url;
                        }
                    } else {
                        const searchResults = await this.tmdbService.search(item.title, item.type as 'movie' | 'tv');
                        if (searchResults && searchResults.results?.length > 0) {
                            const topResult = searchResults.results[0];
                            id = topResult.id;
                            posterPath = topResult.poster_path;
                        }
                    }
                } catch (e) {
                    this.logger.warn(`Failed to resolve ${item.title}: ${e.message}`);
                }

                if (id) {
                    return {
                        playlistId: playlist.id,
                        tmdbId: item.type !== 'anime' ? id : null,
                        malId: item.type === 'anime' ? id : null,
                        type: item.type,
                        title: item.title,
                        posterPath
                    };
                }
                return null;
            })
        );

        const validItems = resolvedItems.filter(i => i !== null);

        if (validItems.length > 0) {
            await this.prisma.playlistItem.createMany({
                data: validItems as any
            });
        }

        return this.getById(playlist.id);
    }

    async getById(id: string) {
        return this.prisma.playlist.findUnique({
            where: { id },
            include: { items: true }
        });
    }
}
