import { ApiProperty } from '@nestjs/swagger';

export class SourceResponseDto {
  @ApiProperty({ format: 'uuid' })
  source_id!: string;

  @ApiProperty({ example: 'crm' })
  name!: string;

  @ApiProperty({ example: 'api' })
  type!: string;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;
}

export interface SourceRegistrationResult {
  body: SourceResponseDto;
  created: boolean;
}
