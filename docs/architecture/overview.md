# Resolve API Architecture

Resolve starts as an npm workspaces modular monolith. The API and worker run as separate processes and share focused TypeScript packages.

```text
Client -> NestJS API -> PostgreSQL
                     -> Redis

BullMQ worker ------> Redis
                  \-> PostgreSQL in later roadmap steps
```

`apps/api` owns HTTP concerns. `apps/worker` owns background execution. `packages/contracts` owns public types and validation, `packages/config` owns process configuration, and `packages/database` owns Prisma.

PostgreSQL is the durable source of truth. Redis supplies queue and coordination infrastructure. Resolve will keep raw records separate from normalized and canonical data when persistence arrives in Week 1 Days 3-4.

The future resolution flow remains:

```text
INGEST -> NORMALIZE -> BLOCK -> COMPARE -> SCORE -> DECIDE
       -> CANONICALIZE -> PERSIST EVIDENCE -> NOTIFY
```

Day 2 implements readiness, configuration, and runtime boundaries. It does not implement domain tables, ingestion, matching, or queue jobs.
