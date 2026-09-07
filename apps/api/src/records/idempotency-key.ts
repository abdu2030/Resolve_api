import { ApiException } from '../common/http/api-exception.js';

export function validateIdempotencyKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[\x21-\x7e]{1,255}$/.test(value)) {
    throw new ApiException(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key must contain 1 to 255 visible ASCII characters without whitespace',
    );
  }
  return value;
}
