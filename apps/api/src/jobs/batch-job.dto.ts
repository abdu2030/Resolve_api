import { ApiProperty } from '@nestjs/swagger';

import { RecordResponseDto } from '../records/record-response.dto.js';

const statuses = ['QUEUED', 'RUNNING', 'RETRYING', 'SUCCEEDED', 'FAILED'] as const;

class JobErrorDto {
  @ApiProperty({ example: 'ENTITY_TYPE_CONFLICT' }) code!: string;
}

class BatchRecordResultDto {
  @ApiProperty({ minimum: 0 }) index!: number;
  @ApiProperty({ type: RecordResponseDto, nullable: true }) result!: RecordResponseDto | null;
  @ApiProperty({ type: JobErrorDto, nullable: true }) error!: JobErrorDto | null;
}

export class AcceptedBatchDto {
  @ApiProperty({ format: 'uuid' }) job_id!: string;
  @ApiProperty({ enum: ['QUEUED'] }) status!: 'QUEUED';
}

export class BatchJobDto {
  @ApiProperty({ format: 'uuid' }) job_id!: string;
  @ApiProperty({ enum: statuses }) status!: (typeof statuses)[number];
  @ApiProperty({ minimum: 1 }) total_records!: number;
  @ApiProperty({ minimum: 0 }) processed_records!: number;
  @ApiProperty({ minimum: 0 }) succeeded_records!: number;
  @ApiProperty({ minimum: 0 }) failed_records!: number;
  @ApiProperty({ minimum: 0 }) attempts!: number;
  @ApiProperty({ type: JobErrorDto, nullable: true }) error!: JobErrorDto | null;
  @ApiProperty({ type: String, format: 'date-time' }) created_at!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) finished_at!: string | null;
  @ApiProperty({ type: [BatchRecordResultDto] }) results!: BatchRecordResultDto[];
}
