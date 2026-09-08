import { DatabaseEntityType } from '@resolve/database';

import {
  companyDomainQuery,
  exactEmailQuery,
  exactPhoneQuery,
  nameLocationQuery,
} from './blocking.queries.js';

const baseInput = {
  schema: 'tenant_schema',
  tenantId: '11111111-1111-1111-1111-111111111111',
  sourceRecordId: '22222222-2222-2222-2222-222222222222',
  entityType: DatabaseEntityType.PERSON,
  limit: 101,
};

describe('blocking query builders', () => {
  it.each([
    ['email', exactEmailQuery, 'User@example.com'],
    ['phone', exactPhoneQuery, '+251911223344'],
    ['domain', companyDomainQuery, 'resolve.example'],
  ] as const)('parameterizes the %s query and its hard limit', (_, builder, value) => {
    const query = builder({ ...baseInput, value });

    expect(query.values).toEqual([
      baseInput.tenantId,
      baseInput.entityType,
      baseInput.sourceRecordId,
      value,
      baseInput.limit,
    ]);
  });

  it('parameterizes every name/location component and its hard limit', () => {
    const query = nameLocationQuery({
      ...baseInput,
      namePrefix: 'abdu hassen',
      city: 'addis ababa',
      country: 'ET',
    });

    expect(query.values).toEqual([
      baseInput.tenantId,
      baseInput.entityType,
      baseInput.sourceRecordId,
      'abdu hassen',
      'addis ababa',
      'ET',
      baseInput.limit,
    ]);
  });

  it('qualifies raw SQL with the configured schema', () => {
    const query = exactEmailQuery({ ...baseInput, value: 'User@example.com' });

    expect(query.text).toContain('"tenant_schema"."source_records"');
    expect(query.text).toContain('"tenant_schema"."entity_record_links"');
    expect(query.text).toContain('"tenant_schema"."entities"');
    expect(query.text).toContain('"tenant_schema"."entity_type"');
  });
});
