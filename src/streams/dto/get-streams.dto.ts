import { IsString, IsOptional, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class GetStreamsDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  season?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  episode?: number;

  @IsOptional()
  @IsString()
  type?: 'sub' | 'dub';

  @IsOptional()
  @IsString()
  mediaType?: 'movie' | 'tv' | 'anime';
}
