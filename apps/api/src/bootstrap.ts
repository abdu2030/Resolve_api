import { type INestApplication, RequestMethod, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json } from 'express';

export function configureApplication(app: INestApplication, requestBodyLimit: string): void {
  app.enableShutdownHooks();
  app.use(json({ limit: requestBodyLimit }));
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
