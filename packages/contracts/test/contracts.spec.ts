import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';

import {
  AddressInputDto,
  CompanyInputDto,
  CreateSourceDto,
  MATCHING_POLICY,
  NORMALIZATION_VERSION,
  PersonInputDto,
  RecordInputDto,
} from '../src/index.js';

const validatePayload = async <T extends object>(
  type: new () => T,
  payload: object,
): Promise<ValidationError[]> =>
  validate(plainToInstance(type, payload), {
    forbidNonWhitelisted: true,
    whitelist: true,
  });

describe('MVP input contracts', () => {
  it('rejects a person without a usable name, email, or phone', async () => {
    await expect(validatePayload(PersonInputDto, {})).resolves.not.toHaveLength(0);
    await expect(validatePayload(PersonInputDto, { name: '   ' })).resolves.not.toHaveLength(0);
  });

  it('accepts a person with one usable identity field', async () => {
    await expect(validatePayload(PersonInputDto, { name: 'Abdulkerim Hassen' })).resolves.toEqual(
      [],
    );
  });

  it('rejects a company without identity evidence and accepts an opaque registration id', async () => {
    await expect(validatePayload(CompanyInputDto, {})).resolves.not.toHaveLength(0);
    await expect(
      validatePayload(CompanyInputDto, { registration_id: 'ET-REG-00042' }),
    ).resolves.toEqual([]);
  });

  it('rejects malformed emails, blank optional strings, and unknown fields', async () => {
    await expect(
      validatePayload(PersonInputDto, { email: 'not-an-email' }),
    ).resolves.not.toHaveLength(0);
    await expect(
      validatePayload(CompanyInputDto, { name: 'Acme', domain: '   ' }),
    ).resolves.not.toHaveLength(0);
    await expect(
      validatePayload(PersonInputDto, { name: 'Abdul', secret_flag: true }),
    ).resolves.not.toHaveLength(0);
  });

  it('normalizes a valid address country code to uppercase and rejects invalid codes', async () => {
    const address = plainToInstance(AddressInputDto, { country: 'et' });

    await expect(validate(address)).resolves.toEqual([]);
    expect(address.country).toBe('ET');
    await expect(validatePayload(AddressInputDto, { country: 'ETH' })).resolves.not.toHaveLength(0);
  });

  it('accepts lowercase source slugs and rejects uppercase names', async () => {
    await expect(
      validatePayload(CreateSourceDto, { name: 'billing_api', type: 'api' }),
    ).resolves.toEqual([]);
    await expect(
      validatePayload(CreateSourceDto, { name: 'Billing', type: 'api' }),
    ).resolves.not.toHaveLength(0);
  });

  it('validates record data using its declared entity type', async () => {
    await expect(
      validatePayload(RecordInputDto, {
        source: 'crm',
        external_id: 'contact-42',
        entity_type: 'person',
        data: { name: 'Abdulkerim Hassen' },
      }),
    ).resolves.toEqual([]);

    await expect(
      validatePayload(RecordInputDto, {
        source: 'crm',
        external_id: 'company-42',
        entity_type: 'company',
        data: {},
      }),
    ).resolves.not.toHaveLength(0);
  });

  it('rejects unknown fields nested inside record data', async () => {
    await expect(
      validatePayload(RecordInputDto, {
        source: 'crm',
        external_id: 'contact-43',
        entity_type: 'person',
        data: { name: 'Abdulkerim Hassen', tenant_id: 'untrusted' },
      }),
    ).resolves.not.toHaveLength(0);
  });
  it('exports the locked normalization and matching policy boundaries', () => {
    expect(NORMALIZATION_VERSION).toBe('normalization-v1');
    expect(MATCHING_POLICY).toEqual({
      version: 'rules-0.1.0',
      weights: {
        email: 0.4,
        phone: 0.25,
        name: 0.2,
        company: 0.1,
        location: 0.05,
      },
      thresholds: {
        autoMatch: 0.92,
        review: 0.72,
      },
      contradictions: {
        warningPenalty: 0.15,
        blockAutoMatch: true,
      },
    });
  });
});
