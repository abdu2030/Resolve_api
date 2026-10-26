import { Module } from '@nestjs/common';

import { EntitiesController } from './entities.controller.js';
import { EntityQueryService } from './entity-query.service.js';

@Module({
  controllers: [EntitiesController],
  providers: [EntityQueryService],
})
export class EntitiesModule {}
