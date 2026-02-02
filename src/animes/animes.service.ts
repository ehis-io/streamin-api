import { Injectable } from '@nestjs/common';
import { MALService } from '../mal/mal.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AnimesService {
    constructor(
        private malService: MALService,
        private prismaService: PrismaService,
    ) { }

    async getTrending(page: number = 1) {
        const data = await this.malService.getTrending(page);
        if (data && (data as any).data) {
            (data as any).data = (data as any).data.map((item: any) => ({
                ...item,
                synopsis: this.cleanSynopsis(item.synopsis),
            }));
        }
        return data;
    }

    async search(query: string, page: number = 1) {
        const data = await this.malService.search(query, page);
        if (data && (data as any).data) {
            (data as any).data = (data as any).data.map((item: any) => ({
                ...item,
                synopsis: this.cleanSynopsis(item.synopsis),
            }));
        }
        return data;
    }

    async getDetails(id: number) {
        const malData = await this.malService.getDetails(id);
        const dbData = await this.prismaService.anime.findUnique({
            where: { malId: id },
            include: { providers: true },
        });

        // Clean synopsis in details
        const cleanedMalData = malData && (malData as any).data ? {
            ...malData,
            data: {
                ...(malData as any).data,
                synopsis: this.cleanSynopsis((malData as any).data.synopsis),
            }
        } : malData;

        return {
            ...cleanedMalData,
            localProviders: dbData?.providers || [],
        };
    }

    private cleanSynopsis(synopsis: string): string {
        if (!synopsis) return synopsis;
        return synopsis
            .replace(/\(Source:.*?\)/gi, '')
            .replace(/\[Written by.*?\]/gi, '')
            .trim();
    }

    async getGenres() {
        const data = await this.malService.getGenres();
        // Jikan returns { data: [] }, frontend expects { genres: [] }
        if (data && (data as any).data) {
            return {
                genres: (data as any).data.map((g: any) => ({
                    id: g.mal_id,
                    name: g.name
                }))
            };
        }
        return { genres: [] };
    }

    async getProducers() {
        const data = await this.malService.getProducers();
        if (data && (data as any).data) {
            return {
                producers: (data as any).data.map((p: any) => ({
                    id: p.mal_id,
                    name: (p.titles && p.titles[0]) ? p.titles[0].title : (p.name || 'Unknown')
                }))
            };
        }
        return { producers: [] };
    }

    async getRecommendations(id: number) {
        return this.malService.getRecommendations(id);
    }

    async discover(params: any) {
        const data = await this.malService.discover(params);
        let results = [];

        if (data && (data as any).data) {
            results = (data as any).data.map((item: any) => ({
                id: item.mal_id,
                title: item.title,
                poster_path: item.images?.jpg?.large_image_url,
                vote_average: item.score,
                release_date: item.aired?.from ? item.aired.from.split('T')[0] : null,
                synopsis: this.cleanSynopsis(item.synopsis),
                // Keep original data just in case
                ...item
            }));
        }

        // Map Jikan response to match TMDB structure expected by frontend
        // Jikan returns { data: [], pagination: {} }
        // Frontend expects { results: [], page: number, total_pages: number }
        return {
            results: results,
            page: (data as any).pagination?.current_page || 1,
            total_pages: (data as any).pagination?.last_visible_page || 1,
            total_results: (data as any).pagination?.items?.total || 0
        };
    }
}
