import { ArgumentsHost, Catch, HttpException, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';

import { ApiException, type ApiErrorBody } from './api-exception.js';

const INTERNAL_ERROR = { code: 'INTERNAL_ERROR', message: 'Internal server error' };
const STATUS_ERRORS: Record<number, ApiErrorBody['error']> = {
  400: { code: 'BAD_REQUEST', message: 'Request validation failed' },
  401: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
  403: { code: 'FORBIDDEN', message: 'Forbidden' },
  404: { code: 'NOT_FOUND', message: 'Resource not found' },
  405: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' },
  408: { code: 'REQUEST_TIMEOUT', message: 'Request timed out' },
  409: { code: 'CONFLICT', message: 'Conflict' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds the size limit' },
  415: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported request body format' },
  422: { code: 'UNPROCESSABLE_ENTITY', message: 'Unprocessable entity' },
  429: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests' },
  500: INTERNAL_ERROR,
  502: { code: 'BAD_GATEWAY', message: 'Bad gateway' },
  503: { code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable' },
  504: { code: 'GATEWAY_TIMEOUT', message: 'Gateway timed out' },
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      if (exception instanceof ApiException) {
        response.status(status).json(payload);
        return;
      }
      const details =
        status === 400 &&
        typeof payload === 'object' &&
        payload !== null &&
        'message' in payload &&
        Array.isArray(payload.message)
          ? { messages: payload.message }
          : undefined;
      const error = STATUS_ERRORS[status] ?? { code: 'HTTP_ERROR', message: 'Request failed' };
      response.status(status).json({
        error: { ...error, ...(details ? { details } : {}) },
      });
      return;
    }
    response.status(500).json({ error: INTERNAL_ERROR });
  }
}
