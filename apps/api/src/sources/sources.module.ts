import { Module } from '@nestjs/common';
import { SourceRegistrationService } from './source-registration.service.js';
import { SourcesController } from './sources.controller.js';

@Module({ controllers: [SourcesController], providers: [SourceRegistrationService] })
export class SourcesModule {}
