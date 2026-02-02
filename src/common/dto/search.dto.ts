import { IsString, IsNotEmpty } from 'class-validator';
import { PaginationDto } from './pagination.dto';

export class SearchDto extends PaginationDto {
    @IsString()
    @IsNotEmpty()
    q: string;
}
