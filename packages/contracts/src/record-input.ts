import { Type } from 'class-transformer';
import { IsDefined, IsEnum, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';

import { CompanyInputDto } from './company-input.dto.js';
import { EntityType } from './entity-type.js';
import { PersonInputDto } from './person-input.dto.js';

interface RecordInputBase {
  external_id: string;
  source: string;
}

export type RecordInput =
  | (RecordInputBase & { data: CompanyInputDto; entity_type: EntityType.Company })
  | (RecordInputBase & { data: PersonInputDto; entity_type: EntityType.Person });

export class RecordInputDto {
  @IsString()
  @Matches(/^[a-z][a-z0-9_-]*$/)
  @MaxLength(120)
  source!: string;

  @IsString()
  @Matches(/\S/)
  @MaxLength(255)
  external_id!: string;

  @IsEnum(EntityType)
  entity_type!: EntityType;

  @IsDefined()
  @ValidateNested()
  @Type((options) =>
    (options?.object as Record<string, unknown> | undefined)?.entity_type === EntityType.Company
      ? CompanyInputDto
      : PersonInputDto,
  )
  data!: CompanyInputDto | PersonInputDto;
}
