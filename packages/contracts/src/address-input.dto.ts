import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class AddressInputDto {
  @IsOptional()
  @IsString()
  @Matches(/\S/)
  @MaxLength(200)
  line1?: string;

  @IsOptional()
  @IsString()
  @Matches(/\S/)
  @MaxLength(200)
  line2?: string;

  @IsOptional()
  @IsString()
  @Matches(/\S/)
  @MaxLength(120)
  city?: string;

  @IsOptional()
  @IsString()
  @Matches(/\S/)
  @MaxLength(120)
  region?: string;

  @IsOptional()
  @IsString()
  @Matches(/\S/)
  @MaxLength(32)
  postal_code?: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{2}$/)
  country?: string;
}
