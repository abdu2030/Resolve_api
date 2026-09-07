import { IsString, Matches, MaxLength } from 'class-validator';

const SOURCE_SLUG = /^[a-z][a-z0-9_-]*$/;

export class CreateSourceDto {
  @IsString()
  @Matches(SOURCE_SLUG)
  @MaxLength(120)
  name!: string;

  @IsString()
  @Matches(SOURCE_SLUG)
  @MaxLength(50)
  type!: string;
}
