import { Module } from '@nestjs/common';

import { CanonicalizationModule } from '../canonicalization/canonicalization.module.js';
import { EntityManagementController } from './entity-management.controller.js';
import { EntityManagementService } from './entity-management.service.js';

import { EntitiesController } from './entities.controller.js';
import { EntityQueryService } from './entity-query.service.js';

@Module({
  imports: [CanonicalizationModule],
  controllers: [EntitiesController, EntityManagementController],
  providers: [EntityQueryService, EntityManagementService],
})
export class EntitiesModule {}
