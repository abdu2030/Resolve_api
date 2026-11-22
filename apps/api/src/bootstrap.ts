import { type INestApplication, RequestMethod, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json, type NextFunction, type Request, type Response } from 'express';

import { ApiExceptionFilter } from './common/http/api-exception.filter.js';
import { ApiException } from './common/http/api-exception.js';
import type { RawBodyRequest } from './common/http/raw-body-request.js';
import type { HttpObservabilityService } from './observability/http-observability.service.js';
import { documentRateLimits } from './rate-limits/rate-limit-openapi.js';

export function configureApplication(
  app: INestApplication,
  requestBodyLimit: string,
  observability?: HttpObservabilityService,
): void {
  app.enableShutdownHooks();
  if (observability) app.use(observability.observe);
  app.use(
    json({
      limit: requestBodyLimit,
      verify: (request_, _response, buffer) => {
        (request_ as RawBodyRequest).rawBody = Buffer.from(buffer);
      },
    }),
  );
  app.use(handleJsonParserError);
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
    }),
  );
  app.setGlobalPrefix('v1', {
    exclude: ['health', 'health/live', 'health/ready', 'metrics'].map((path) => ({
      method: RequestMethod.GET,
      path,
    })),
  });

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Resolve API')
      .setDescription('Explainable, reversible entity resolution for person and company records.')
      .setVersion('0.1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'api-key')
      .build(),
  );
  documentRateLimits(document);
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs-json',
  });
}

function handleJsonParserError(
  error: unknown,
  _request: Request,
  _response: Response,
  next: NextFunction,
): void {
  // Parser errors can contain raw payloads. Expose only a safe description of recognized failures.
  if (typeof error === 'object' && error !== null && 'type' in error) {
    switch (error.type) {
      case 'entity.parse.failed':
        return next(new ApiException(400, 'BAD_REQUEST', 'Malformed JSON body'));
      case 'entity.too.large':
        return next(
          new ApiException(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds the size limit'),
        );
      case 'charset.unsupported':
      case 'encoding.unsupported':
        return next(
          new ApiException(415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported request body format'),
        );
      case 'request.aborted':
      case 'request.size.invalid':
        return next(new ApiException(400, 'BAD_REQUEST', 'Invalid request body'));
    }
  }
  next(error);
}
