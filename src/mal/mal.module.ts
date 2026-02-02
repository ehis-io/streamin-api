import { Module, Global } from '@nestjs/common';
import {
    JikanClient,
    AnimeEndpoint,
    MangaEndpoint,
    CharactersEndpoint,
    PeopleEndpoint,
    ClubsEndpoint,
    SeasonsEndpoint,
    SchedulesEndpoint,
    TopEndpoint,
    GenresEndpoint,
    ProducersEndpoint,
    MagazinesEndpoint,
    UsersEndpoint,
    ReviewsEndpoint,
    RecommendationsEndpoint,
    RandomEndpoint
} from 'myanimelist-wrapper';
import { MALService } from './mal.service';

const jikanClient = new JikanClient();

@Global()
@Module({
    providers: [
        {
            provide: JikanClient,
            useValue: jikanClient,
        },
        {
            provide: AnimeEndpoint,
            useValue: jikanClient.anime,
        },
        {
            provide: MangaEndpoint,
            useValue: jikanClient.manga,
        },
        {
            provide: CharactersEndpoint,
            useValue: jikanClient.characters,
        },
        {
            provide: PeopleEndpoint,
            useValue: jikanClient.people,
        },
        {
            provide: ClubsEndpoint,
            useValue: jikanClient.clubs,
        },
        {
            provide: SeasonsEndpoint,
            useValue: jikanClient.seasons,
        },
        {
            provide: SchedulesEndpoint,
            useValue: jikanClient.schedules,
        },
        {
            provide: TopEndpoint,
            useValue: jikanClient.top,
        },
        {
            provide: GenresEndpoint,
            useValue: jikanClient.genres,
        },
        {
            provide: ProducersEndpoint,
            useValue: jikanClient.producers,
        },
        {
            provide: MagazinesEndpoint,
            useValue: jikanClient.magazines,
        },
        {
            provide: UsersEndpoint,
            useValue: jikanClient.users,
        },
        {
            provide: ReviewsEndpoint,
            useValue: jikanClient.reviews,
        },
        {
            provide: RecommendationsEndpoint,
            useValue: jikanClient.recommendations,
        },
        {
            provide: RandomEndpoint,
            useValue: jikanClient.random,
        },
        MALService,
    ],
    exports: [
        MALService,
        JikanClient,
        AnimeEndpoint,
        MangaEndpoint,
        CharactersEndpoint,
        PeopleEndpoint,
        ClubsEndpoint,
        SeasonsEndpoint,
        SchedulesEndpoint,
        TopEndpoint,
        GenresEndpoint,
        ProducersEndpoint,
        MagazinesEndpoint,
        UsersEndpoint,
        ReviewsEndpoint,
        RecommendationsEndpoint,
        RandomEndpoint
    ],
})
export class MALModule { }
