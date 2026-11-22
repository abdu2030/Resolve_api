import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

import { WEBHOOK_EVENTS, type WebhookEventType } from './webhook-events.js';

export class RegisterWebhookEndpointDto {
  @ApiProperty({
    format: 'uri',
    maxLength: 2048,
    example: 'https://integrator.example/hooks/resolve',
  })
  @IsString()
  @MaxLength(2048)
  url!: string;

  @ApiProperty({ enum: [...WEBHOOK_EVENTS], isArray: true, uniqueItems: true, minItems: 1 })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @ArrayMaxSize(WEBHOOK_EVENTS.length)
  @IsIn(WEBHOOK_EVENTS, { each: true })
  events!: WebhookEventType[];

  @ApiProperty({ writeOnly: true, pattern: '^[A-Fa-f0-9]{64}$' })
  @IsString()
  @Matches(/^[a-f0-9]{64}$/i)
  signing_secret!: string;
}

export class WebhookEndpointDto {
  @ApiProperty({ format: 'uuid' }) endpoint_id!: string;
  @ApiProperty({ format: 'uri' }) url!: string;
  @ApiProperty({ enum: [...WEBHOOK_EVENTS], isArray: true }) events!: string[];
  @ApiProperty({ format: 'date-time' }) created_at!: string;
}

export class WebhookDeliveryQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  cursor?: string;
}

const DELIVERY_STATES = ['PENDING', 'RUNNING', 'DELIVERED', 'DEAD_LETTER'] as const;

export class WebhookDeliveryDto {
  @ApiProperty({ format: 'uuid' }) delivery_id!: string;
  @ApiProperty({ format: 'uuid' }) event_id!: string;
  @ApiProperty({ enum: [...WEBHOOK_EVENTS] }) type!: string;
  @ApiProperty({ enum: [...DELIVERY_STATES] }) status!: (typeof DELIVERY_STATES)[number];
  @ApiProperty() attempts!: number;
  @ApiProperty({ type: String, nullable: true }) last_error!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) finished_at!: string | null;
  @ApiProperty({ format: 'date-time' }) created_at!: string;
}

export class WebhookDeliveryPageDto {
  @ApiProperty({ type: [WebhookDeliveryDto] }) deliveries!: WebhookDeliveryDto[];
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) next_cursor!: string | null;
}

class WebhookAttemptDto {
  @ApiProperty() number!: number;
  @ApiProperty({ enum: ['STARTED', 'DELIVERED', 'FAILED', 'INTERRUPTED'] }) outcome!: string;
  @ApiProperty({ type: Number, nullable: true }) http_status!: number | null;
  @ApiProperty({ type: String, nullable: true }) error_code!: string | null;
  @ApiProperty({ format: 'date-time' }) started_at!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) finished_at!: string | null;
}

export class WebhookDeliveryDetailDto extends WebhookDeliveryDto {
  @ApiProperty({ type: [WebhookAttemptDto], maxItems: 50 }) attempt_history!: WebhookAttemptDto[];
}

export class WebhookReplayDto {
  @ApiProperty({ format: 'uuid' }) delivery_id!: string;
  @ApiProperty({ format: 'uuid' }) event_id!: string;
  @ApiProperty({ enum: ['PENDING'] }) status!: 'PENDING';
}
