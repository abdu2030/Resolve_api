import { HttpException } from '@nestjs/common';

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export class ApiException extends HttpException {
  constructor(status: number, code: string, message: string, details?: unknown) {
    const error = details === undefined ? { code, message } : { code, message, details };
    super({ error }, status);
    this.message = message;
  }
}
