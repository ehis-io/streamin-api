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
        origin: '*',
    },
})
export class StreamsGateway implements OnGatewayConnection, OnGatewayDisconnect {
    private readonly logger = new Logger(StreamsGateway.name);

    @WebSocketServer()
    server: Server;

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
        this.logger.log(`Prefetch started via WS for ${data.items.length} items`);

        try {
            await this.providersService.prefetchLinks(data.items, (id, link) => {
                client.emit('prefetch-link', { id, link });
            });
            client.emit('prefetch-complete', { success: true });
        } catch (err) {
            this.logger.error(`WS Prefetch failed: ${err.message}`);
            client.emit('prefetch-complete', { success: false, error: err.message });
        }
    }

    @SubscribeMessage('find-streams')
    async handleFindStreams(
        @MessageBody() data: { id: string, season?: number, episode?: number, type: 'sub' | 'dub', mediaType: string },
        @ConnectedSocket() client: Socket,
    ) {
        this.logger.log(`Find streams started via WS for ${data.id}`);

        try {
            const links = await this.providersService.findStreamLinks(
                data.id,
                data.season,
                data.episode,
                data.type,
                data.mediaType,
                (link) => {
                    client.emit('stream-link', link);
                },
            );

            client.emit('streams-complete', links);
        } catch (err) {
            this.logger.error(`WS find-streams failed: ${err.message}`);
            client.emit('streams-complete', []);
        }
    }
}
