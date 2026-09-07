import { type INestApplication, RequestMethod, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json } from 'express';

import { ApiExceptionFilter } from './common/http/api-exception.filter.js';
import type { RawBodyRequest } from './common/http/raw-body-request.js';

export function configureApplication(app: INestApplication, requestBodyLimit: string): void {
  app.enableShutdownHooks();
  app.use(
    json({
      limit: requestBodyLimit,
      verify: (request_, _response, buffer) => {
        (request_ as RawBodyRequest).rawBody = Buffer.from(buffer);
      },
    }),
  );
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
    }),
  );
  app.setGlobalPrefix('v1', {
    exclude: [{ method: RequestMethod.GET, path: 'health' }],
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
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs-json',
  });
}
