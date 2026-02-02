import { Module } from '@nestjs/common';
import { PlaylistsController } from './playlists.controller';
import { PlaylistsService } from './playlists.service';
import { AiModule } from '../ai/ai.module';
import { TmdbModule } from '../tmdb/tmdb.module';
import { MALModule } from '../mal/mal.module';

@Module({
    imports: [AiModule, TmdbModule, MALModule],
    controllers: [PlaylistsController],
    providers: [PlaylistsService],
})
export class PlaylistsModule { }
