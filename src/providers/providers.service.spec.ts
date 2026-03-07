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

  describe('findStreamLinks', () => {
    it('should retrieve links older than 4 hours but newer than 7 days from the database', async () => {
      const tmdbId = 12345;
      const title = 'Test Movie';
      const dbSeason = null;
      const dbEpisode = null;
      const type = 'sub';

      (service as any).tmdbService.getDetails.mockResolvedValue({ title, id: tmdbId });
      (service as any).cacheManager.get.mockResolvedValue(null);

      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
      const mockDbLinks = [
        {
          url: 'http://test.com/stream.m3u8',
          quality: '1080p',
          isM3U8: true,
          headers: null,
          provider: 'TestProvider',
          createdAt: fiveHoursAgo
        }
      ];

      (service as any).prisma.streamedLink.findMany.mockResolvedValue(mockDbLinks);

      const result = await service.findStreamLinks(tmdbId.toString(), undefined, undefined, type, 'movie');

      expect(result).toHaveLength(1);
      expect(result[0].url).toBe('http://test.com/stream.m3u8');
      expect((service as any).prisma.streamedLink.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          tmdbId,
          season: dbSeason,
          episode: dbEpisode,
          type,
        })
      }));
    });
  });
});
