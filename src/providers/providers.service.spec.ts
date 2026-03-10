import { Test, TestingModule } from '@nestjs/testing';
import { ProvidersService } from './providers.service';
import { TmdbService } from '../tmdb/tmdb.service';
import { MALService } from '../mal/mal.service';
import { PrismaService } from '../prisma/prisma.service';
import { StreamValidationService } from './stream-validation.service';
import { StreamCacheService } from './stream-cache.service';
import { ConfigService } from '@nestjs/config';
import { SCRAPER_TOKEN } from './scraper.interface';

describe('ProvidersService', () => {
  let service: ProvidersService;
  let cacheService: StreamCacheService;

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
        },
        {
          provide: StreamValidationService,
          useValue: {
            validateStream: jest.fn().mockResolvedValue(true),
          }
        },
        {
          provide: StreamCacheService,
          useValue: {
            buildCacheKey: jest.fn().mockReturnValue('test-key'),
            getFromRedis: jest.fn().mockResolvedValue(null),
            getFromDatabase: jest.fn().mockResolvedValue(null),
            saveToRedis: jest.fn(),
            saveToDatabase: jest.fn(),
          }
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue(30000),
          }
        },
      ],
    }).compile();

    service = module.get<ProvidersService>(ProvidersService);
    cacheService = module.get<StreamCacheService>(StreamCacheService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findStreamLinks', () => {
    it('should return cached links from the database via StreamCacheService', async () => {
      const tmdbId = 12345;
      const title = 'Test Movie';

      (service as any).tmdbService.getDetails.mockResolvedValue({ title, id: tmdbId });

      const mockDbLinks = [
        {
          url: 'http://test.com/stream.m3u8',
          quality: '1080p',
          isM3U8: true,
          headers: undefined,
          provider: 'TestProvider',
        }
      ];

      (cacheService.getFromDatabase as jest.Mock).mockResolvedValue(mockDbLinks);

      const result = await service.findStreamLinks(tmdbId.toString(), undefined, undefined, 'sub', 'movie');

      expect(result.links).toHaveLength(1);
      expect(result.links[0].url).toBe('http://test.com/stream.m3u8');
      expect(result.scraperStatuses).toHaveLength(1);
      expect(result.scraperStatuses[0].name).toBe('cache:database');
    });

    it('should return empty result for invalid IDs', async () => {
      const result = await service.findStreamLinks('invalid', undefined, undefined, 'sub', 'movie');
      expect(result.links).toHaveLength(0);
      expect(result.scraperStatuses).toHaveLength(0);
    });
  });
});
