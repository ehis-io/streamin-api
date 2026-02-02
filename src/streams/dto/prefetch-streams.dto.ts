import { IsString, IsArray, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class PrefetchItem {
    @IsString()
    id: string;

    @IsString()
    mediaType: 'movie' | 'tv' | 'anime';

    @IsOptional()
    @IsString()
    title?: string;
}

export class PrefetchStreamsDto {
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => PrefetchItem)
    items: PrefetchItem[];
}
