import { Type } from 'class-transformer';
import {
  IsEmail,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { AddressInputDto } from './address-input.dto.js';
import { RequireAtLeastOne } from './require-at-least-one.decorator.js';

export class CompanyInputDto {
  @RequireAtLeastOne(['name', 'domain', 'email', 'phone', 'registration_id'])
  private readonly identityRequirement?: never;

  @IsOptional()
  @IsString()
  @Matches(/\S/)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(/\S/)
  @MaxLength(253)
  domain?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @IsOptional()
  @IsString()
  @Matches(/\S/)
  @MaxLength(64)
  phone?: string;

  @IsOptional()
  @IsString()
  @Matches(/\S/)
  @MaxLength(160)
  registration_id?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AddressInputDto)
  address?: AddressInputDto;

  @IsOptional()
  @IsObject()
  attributes?: Record<string, unknown>;
}
