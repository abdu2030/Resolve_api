import type { CompanyInputDto } from './company-input.dto.js';
import type { EntityType } from './entity-type.js';
import type { PersonInputDto } from './person-input.dto.js';

interface RecordInputBase {
  external_id: string;
  source: string;
}

export type RecordInput =
  | (RecordInputBase & {
      data: CompanyInputDto;
      entity_type: EntityType.Company;
    })
  | (RecordInputBase & {
      data: PersonInputDto;
      entity_type: EntityType.Person;
    });
