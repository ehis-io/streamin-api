import { Test, TestingModule } from '@nestjs/testing';
import { MALService } from './mal.service';

describe('MALService', () => {
    let service: MALService;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [MALService],
        }).compile();

        service = module.get<MALService>(MALService);
    });

    it('should be defined', () => {
        expect(service).toBeDefined();
    });
});
