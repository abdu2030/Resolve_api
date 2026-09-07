import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';

import type { ApiErrorBody } from './api-exception.js';

const STATUS_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'TOO_MANY_REQUESTS',
  503: 'SERVICE_UNAVAILABLE',
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      if (isApiErrorBody(payload)) {
        response.status(status).json(payload);
        return;
      }
      const details =
        typeof payload === 'object' && payload !== null && 'message' in payload
          ? { messages: Array.isArray(payload.message) ? payload.message : [payload.message] }
          : undefined;
      response.status(status).json({
        error: {
          code: STATUS_CODES[status] ?? 'HTTP_ERROR',
          message:
            status === Number(HttpStatus.BAD_REQUEST)
              ? 'Request validation failed'
              : exception.message,
          ...(details ? { details } : {}),
        },
      });
      return;
    }
    response
      .status(500)
      .json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return typeof value === 'object' && value !== null && 'error' in value;
}
