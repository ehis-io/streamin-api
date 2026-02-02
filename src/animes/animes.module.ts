import { Module } from '@nestjs/common';
import { AnimesService } from './animes.service';
import { AnimesController } from './animes.controller';
import { MALModule } from '../mal/mal.module';

@Module({
    imports: [MALModule],
    controllers: [AnimesController],
    providers: [AnimesService],
})
export class AnimesModule { }
