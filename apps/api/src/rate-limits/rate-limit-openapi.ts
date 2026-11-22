import type { OpenAPIObject } from '@nestjs/swagger';

import { API_ERROR_SCHEMA } from '../common/http/api-error-schema.js';

export function documentRateLimits(document: OpenAPIObject): void {
  for (const path of Object.values(document.paths)) {
    for (const operation of [
      path.get,
      path.post,
      path.put,
      path.patch,
      path.delete,
      path.head,
      path.options,
    ]) {
      if (!operation?.security?.some((security) => Object.hasOwn(security, 'api-key'))) continue;
      operation.responses['429'] = {
        description: 'A request budget is exhausted.',
        headers: {
          'Retry-After': {
            description: 'Seconds to wait before retrying.',
            schema: { type: 'integer', minimum: 1 },
          },
        },
        content: { 'application/json': { schema: API_ERROR_SCHEMA } },
      };
      operation.responses['503'] ??= {
        description: 'A required dependency, including rate limiting, is temporarily unavailable.',
        content: { 'application/json': { schema: API_ERROR_SCHEMA } },
      };
    }
  }
}
