import { ApiProperty } from '@nestjs/swagger';

export class SourceResponseDto {
  @ApiProperty({ format: 'uuid' })
  source_id!: string;

  @ApiProperty({ example: 'crm' })
  name!: string;

  @ApiProperty({ example: 'api' })
  type!: string;

  @ApiProperty({ minimum: 0, maximum: 1000, example: 100 })
  priority!: number;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;
}

export interface SourceRegistrationResult {
  body: SourceResponseDto;
  created: boolean;
}
