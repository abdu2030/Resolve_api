import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsObject, ValidateNested } from 'class-validator';

import { RecordInputDto } from './record-input.js';

export const BATCH_MAX_RECORDS = 100;

export class BatchInputDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BATCH_MAX_RECORDS)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => RecordInputDto)
  records!: RecordInputDto[];
}
