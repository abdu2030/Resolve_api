import { type ContradictionEvidence, type EntityType } from '@resolve/contracts';

export const FEATURE_VERSION = 'features-v1' as const;

export interface ComparisonRecord {
  entityType: EntityType;
  normalizedPayload: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
}

export interface PersonFeatures {
  email_exact: boolean | null;
  phone_exact: boolean | null;
  name_edit_similarity: number | null;
  name_jaro_winkler_similarity: number | null;
  company_name_token_similarity: number | null;
  company_domain_exact: boolean | null;
  address_token_similarity: number | null;
  country_exact: boolean | null;
}

export interface CompanyFeatures {
  email_exact: boolean | null;
  phone_exact: boolean | null;
  company_name_edit_similarity: number | null;
  company_name_jaro_winkler_similarity: number | null;
  company_name_token_similarity: number | null;
  domain_exact: boolean | null;
  address_token_similarity: number | null;
  country_exact: boolean | null;
  registration_id_exact: boolean | null;
}

export type FeatureExtractionResult =
  | {
      featureVersion: typeof FEATURE_VERSION;
      entityType: EntityType.Person;
      features: PersonFeatures;
      contradictions: ContradictionEvidence[];
    }
  | {
      featureVersion: typeof FEATURE_VERSION;
      entityType: EntityType.Company;
      features: CompanyFeatures;
      contradictions: ContradictionEvidence[];
    };
