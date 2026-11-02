import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidateIf,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';

function lowercase(value: unknown): unknown {
  return typeof value === 'string' ? value.toLowerCase() : value;
}

@ValidatorConstraint({ name: 'exclusiveSplitSelector', async: false })
class ExclusiveSplitSelector implements ValidatorConstraintInterface {
  validate(_value: unknown, arguments_: ValidationArguments): boolean {
    const input = arguments_.object as SplitEntityDto;
    // Null is supplied input, not an omitted selector; it must never bypass validation.
    return (input.record_ids !== undefined) !== (input.merge_event_id !== undefined);
  }

  defaultMessage(): string {
    return 'Exactly one of record_ids and merge_event_id is required';
  }
}

export class MergeEntityDto {
  @Transform(({ value }: { value: unknown }) => lowercase(value))
  @IsUUID('4')
  source_entity_id!: string;

  @IsInt()
  @Min(0)
  @Max(2147483647)
  expected_source_version!: number;

  @IsInt()
  @Min(0)
  @Max(2147483647)
  expected_target_version!: number;

  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class SplitEntityDto {
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value) ? value.map(lowercase) : value,
  )
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  record_ids?: string[];

  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) => lowercase(value))
  @IsUUID('4')
  merge_event_id?: string;

  @Validate(ExclusiveSplitSelector)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  expected_version!: number;

  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
