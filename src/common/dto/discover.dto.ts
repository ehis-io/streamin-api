import { IsOptional, IsString, IsNumber, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { PaginationDto } from './pagination.dto';

export class DiscoverDto extends PaginationDto {
    @IsOptional()
    @IsString()
    sort_by?: string;

    @IsOptional()
    @IsString()
    with_genres?: string;

    @IsOptional()
    @IsString()
    'primary_release_date.gte'?: string;

    @IsOptional()
    @IsString()
    'primary_release_date.lte'?: string;

    @IsOptional()
    @IsString()
    'first_air_date.gte'?: string;

    @IsOptional()
    @IsString()
    'first_air_date.lte'?: string;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    'vote_average.gte'?: number;

    @IsOptional()
    @IsString()
    producers?: string;
}
