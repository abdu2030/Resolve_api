import { Module } from '@nestjs/common';
import { CanonicalizationModule } from '../canonicalization/canonicalization.module.js';
import { ReviewDecisionService } from './review-decision.service.js';
import { ReviewQueryService } from './review-query.service.js';
import { ReviewsController } from './reviews.controller.js';

@Module({
  imports: [CanonicalizationModule],
  controllers: [ReviewsController],
  providers: [ReviewQueryService, ReviewDecisionService],
})
export class ReviewsModule {}
