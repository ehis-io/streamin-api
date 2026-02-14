import { Test, TestingModule } from '@nestjs/testing';
import { ProvidersService } from './providers.service';
import { TmdbService } from '../tmdb/tmdb.service';
import { MALService } from '../mal/mal.service';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { PrismaService } from '../prisma/prisma.service';
import { SCRAPER_TOKEN } from './scraper.interface';

describe('ProvidersService', () => {
  let service: ProvidersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProvidersService,
        {
          provide: SCRAPER_TOKEN,
          useValue: []
        },
        {
          provide: TmdbService,
          useValue: {
            search: jest.fn(),
            getDetails: jest.fn(),
          }
        },
        {
          provide: MALService,
          useValue: {
            getDetails: jest.fn(),
          }
        },
        {
          provide: CACHE_MANAGER,
          useValue: {
            get: jest.fn(),
            set: jest.fn(),
          }
        },
        {
          provide: PrismaService,
          useValue: {
            streamedLink: {
              findMany: jest.fn(),
              findFirst: jest.fn(),
              create: jest.fn(),
            },
            providerMapping: {
              findUnique: jest.fn(),
              upsert: jest.fn(),
            }
          }
        }
      ],
    }).compile();

    service = module.get<ProvidersService>(ProvidersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
