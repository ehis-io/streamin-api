import {
    WebSocketGateway,
    SubscribeMessage,
    MessageBody,
    ConnectedSocket,
    WebSocketServer,
    OnGatewayConnection,
    OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { ProvidersService } from '../providers/providers.service';
import { Logger } from '@nestjs/common';

@WebSocketGateway({
    cors: {
        origin: true,
        credentials: true,
    },
})
export class StreamsGateway implements OnGatewayConnection, OnGatewayDisconnect {
    private readonly logger = new Logger(StreamsGateway.name);

    @WebSocketServer()
    server!: Server;

    constructor(private readonly providersService: ProvidersService) { }

    handleConnection(client: Socket) {
        this.logger.log(`Client connected: ${client.id}`);
    }

    handleDisconnect(client: Socket) {
        this.logger.log(`Client disconnected: ${client.id}`);
    }

    @SubscribeMessage('prefetch')
    async handlePrefetch(
        @MessageBody() data: { items: { id: string, mediaType: 'movie' | 'tv' | 'anime', title?: string }[] },
        @ConnectedSocket() client: Socket,
    ) {
        // WS payloads bypass the HTTP ValidationPipe, so validate the shape here.
        if (!data || !Array.isArray(data.items) || data.items.length === 0) {
            client.emit('prefetch-complete', { success: false, error: 'items must be a non-empty array' });
            return;
        }

        this.logger.log(`Prefetch started via WS for ${data.items.length} items`);

        try {
            await this.providersService.prefetchLinks(data.items, (id, link, mediaType) => {
                // Always include the season/episode the prefetch scraped for (S1E1 for TV/anime).
                // Frontend uses this to key the cache so episode 5 doesn't accidentally play episode 1.
                const isSeries = mediaType === 'tv' || mediaType === 'anime';
                client.emit('prefetch-link', {
                    id,
                    link,
                    mediaType,
                    season: isSeries ? 1 : null,
                    episode: isSeries ? 1 : null,
                });
            });
            client.emit('prefetch-complete', { success: true });
        } catch (err: any) {
            this.logger.error(`WS Prefetch failed: ${err.message}`);
            client.emit('prefetch-complete', { success: false, error: err.message });
        }
    }

    @SubscribeMessage('find-streams')
    async handleFindStreams(
        @MessageBody() data: { id: string, season?: number, episode?: number, type: 'sub' | 'dub', mediaType: string, requestId: string },
        @ConnectedSocket() client: Socket,
    ) {
        this.logger.log(`Find streams started via WS for ${data.id} (Request ID: ${data.requestId})`);

        try {
            const result = await this.providersService.findStreamLinks(
                data.id,
                data.season,
                data.episode,
                data.type,
                data.mediaType,
                (link) => {
                    this.logger.debug(`[WS] Emitting stream-link for ${data.id} (Req: ${data.requestId})`);
                    client.emit('stream-link', { link, requestId: data.requestId });
                },
                0
            );

            this.logger.log(`[WS] find-streams complete for ${data.id}. Found ${result.links.length} links.`);
            client.emit('streams-complete', { links: result.links, scraperStatuses: result.scraperStatuses, requestId: data.requestId });
        } catch (err: any) {
            this.logger.error(`WS find-streams failed: ${err.message}`);
            client.emit('streams-complete', { links: [], scraperStatuses: [], requestId: data.requestId });
        }
    }
}
