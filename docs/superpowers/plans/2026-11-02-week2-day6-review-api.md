# Week 2 Day 6: review API

Base: `b9418cc`; branch `codex/week2-day6-review-api`. Reuse the existing
worktree/dependencies. Leave changes uncommitted for the user's review.

1. Add review read/write scopes, strict decision/list contracts, captured evidence
   record versions, and append-only human outcomes with tenant-safe foreign keys.
2. Implement bounded keyset listing and evidence inspection. Show historical
   evidence separately from current source/candidate data and human outcomes.
3. Implement transactional approve/reject, required idempotency keys, actor/reason,
   membership coordination, canonical history, and current ingestion responses.
4. Test real HTTP/PostgreSQL happy paths, stale evidence, security, replay,
   concurrency, rollback, and migration preservation. Update Swagger/docs/manual
   PowerShell guide; run appropriate static, build, unit, and integration checks.

## Contract decisions

- GET `/v1/reviews` defaults OPEN, accepts OPEN/RESOLVED, limit 1..100 (default25),
  and an opaque keyset cursor. GET `/v1/reviews/:reviewId` inspects evidence.
- POST `/v1/reviews/:reviewId/decision` accepts APPROVE/REJECT, trimmed reason
  1..500 Unicode characters, expected_source_version, expected_candidate_version
  (the current candidate canonical version), and requires Idempotency-Key.
- APPROVE links the unlinked source to its original ACTIVE same-type candidate;
  REJECT creates a separate entity and links the source there. Both return200,
  store one immutable human outcome, close the case, and recompute canonical data.
- Preserve machine score/features/explanation/algorithm. New links retain REVIEW
  as machine evidence; an explicit review-decision reference explains assignment.
  Current ingestion translates the human outcome to linked AUTO_MATCH/NO_MATCH
  semantics and exposes review_decision_id, retaining the original score. Stored
  keyed ingestion responses remain historical.
- Lock order: idempotency -> exclusive tenant membership gate -> canonical entity
  lock. This serializes with ingestion/merge/split without shared-lock upgrades.
- Approval refuses changed source/supporting record versions, moved supporting
  records, MERGED candidates, stale expected versions, and already-linked sources.
  Legacy cases lack captured versions: only untouched version1 source/supporting
  records can be approved. Never infer a historical version from updated data.
  Rejection may use current source values even when candidate evidence is stale;
  expected_source_version still prevents a concurrent source change.
- Outcomes store actor API-key ID, reason, original case reference, observed record
  and candidate versions, resulting entity/canonical version, and policy review-v1.
  Raw data, original evidence, existing snapshots, and earlier decisions are kept.
- Additive nullable audit references appear on links/history/ingestion. Review
  approval/rejection always appends one canonical snapshot even for equal winners.
- No scorer/threshold changes, new dependencies, quality dashboard, bulk decisions,
  alternate-candidate selection, or re-scoring endpoint in this task.
