import { Test, TestingModule } from '@nestjs/testing';
import { TmdbService } from './tmdb.service';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import axios from 'axios';

jest.mock('axios');

describe('TmdbService', () => {
  let service: TmdbService;
  let cacheManager: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TmdbService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key) => {
              if (key === 'TMDB_API_KEY') return 'test_api_key';
              return null;
            }),
          },
        },
        {
          provide: CACHE_MANAGER,
          useValue: {
            get: jest.fn(),
            set: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<TmdbService>(TmdbService);
    cacheManager = module.get(CACHE_MANAGER);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('filterFutureContent', () => {
    it('should filter out movies with future release dates', async () => {
      const today = new Date();
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      const futureDate = tomorrow.toISOString().split('T')[0];
      const pastDate = yesterday.toISOString().split('T')[0];

      const mockResponse = {
        results: [
          { id: 1, title: 'Past Movie', release_date: pastDate },
          { id: 2, title: 'Future Movie', release_date: futureDate },
        ],
      };

      (axios.get as jest.Mock).mockResolvedValue({ data: mockResponse });
      cacheManager.get.mockResolvedValue(null);

      const result = await service.getTrending('movie');

      expect(result.results).toHaveLength(1);
      expect(result.results[0].id).toBe(1);
      expect(result.results[0].title).toBe('Past Movie');
    });

    it('should filter out tv shows with future first air dates', async () => {
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
  
        const futureDate = tomorrow.toISOString().split('T')[0];
        const pastDate = yesterday.toISOString().split('T')[0];
  
        const mockResponse = {
          results: [
            { id: 1, name: 'Past Show', first_air_date: pastDate },
            { id: 2, name: 'Future Show', first_air_date: futureDate },
          ],
        };
  
        (axios.get as jest.Mock).mockResolvedValue({ data: mockResponse });
        cacheManager.get.mockResolvedValue(null);
  
        const result = await service.getTrending('tv');
  
        expect(result.results).toHaveLength(1);
        expect(result.results[0].id).toBe(1);
        expect(result.results[0].name).toBe('Past Show');
      });

    it('should apply filtering to cached data', async () => {
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        
        const futureDate = tomorrow.toISOString().split('T')[0];
  
        const mockCachedData = {
          results: [
             { id: 2, title: 'Future Movie', release_date: futureDate },
          ],
        };
  
        cacheManager.get.mockResolvedValue(mockCachedData);
  
        const result = await service.getTrending('movie');
  
        expect(result.results).toHaveLength(0);
    });
  });
});
