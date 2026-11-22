import { applyDecorators } from '@nestjs/common';
import {
  ApiPayloadTooLargeResponse,
  ApiUnsupportedMediaTypeResponse,
  type SchemaObject,
} from '@nestjs/swagger';
import { EntityType } from '@resolve/contracts';

import { API_ERROR_SCHEMA } from '../common/http/api-error-schema.js';

function nonBlank(maxLength: number): SchemaObject {
  return { type: 'string', nullable: true, pattern: '\\S', maxLength };
}

const address: SchemaObject = {
  type: 'object',
  nullable: true,
  additionalProperties: false,
  properties: {
    line1: nonBlank(200),
    line2: nonBlank(200),
    city: nonBlank(120),
    region: nonBlank(120),
    postal_code: nonBlank(32),
    country: {
      type: 'string',
      nullable: true,
      pattern: '^\\s*[A-Za-z]{2}\\s*$',
      description:
        'Two-letter country code. Surrounding whitespace and letter case are normalized.',
      example: 'ET',
    },
  },
};

const commonData = {
  name: nonBlank(200),
  email: { type: 'string', format: 'email', nullable: true, maxLength: 320 } as const,
  phone: nonBlank(64),
  address,
  attributes: { type: 'object', nullable: true, additionalProperties: true } as const,
};

function dataSchema(
  properties: Record<string, SchemaObject>,
  identityFields: string[],
): SchemaObject {
  return {
    type: 'object',
    additionalProperties: false,
    description: 'Supply at least one of ' + identityFields.join(', ') + '.',
    properties,
    anyOf: identityFields.map((field) => ({
      required: [field],
      properties: { [field]: { type: 'string', pattern: '\\S' } },
    })),
  };
}

export const RECORD_REQUEST_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['source', 'external_id', 'entity_type', 'data'],
  additionalProperties: false,
  properties: {
    source: { type: 'string', pattern: '^[a-z][a-z0-9_-]*$', maxLength: 120 },
    external_id: { type: 'string', pattern: '\\S', maxLength: 255 },
    entity_type: { type: 'string', enum: Object.values(EntityType) },
    data: { type: 'object' },
  },
  oneOf: [
    {
      properties: {
        entity_type: { enum: [EntityType.Person] },
        data: dataSchema(
          {
            ...commonData,
            company: nonBlank(200),
            company_domain: nonBlank(253),
          },
          ['name', 'email', 'phone'],
        ),
      },
    },
    {
      properties: {
        entity_type: { enum: [EntityType.Company] },
        data: dataSchema(
          {
            ...commonData,
            domain: nonBlank(253),
            registration_id: nonBlank(160),
          },
          ['name', 'domain', 'email', 'phone', 'registration_id'],
        ),
      },
    },
  ],
};

export function ApiRecordBodyErrors(): MethodDecorator {
  return applyDecorators(
    ApiPayloadTooLargeResponse({
      description: 'JSON body exceeds the configured limit.',
      schema: API_ERROR_SCHEMA,
    }),
    ApiUnsupportedMediaTypeResponse({
      description: 'Unsupported JSON encoding or charset.',
      schema: API_ERROR_SCHEMA,
    }),
  );
}
