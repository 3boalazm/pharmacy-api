# Pharmacy SaaS — Backend (NestJS Modular Monolith)

Implements — without deviation — the **CTO Architecture Decision Document v1.0** and
**API Contract Specification v1.0**. ADRs honored: ADR-001 Modular Monolith,
ADR-002 Transactional Outbox, ADR-003 Shared-schema multi-tenancy + RLS,
ADR-004 Synchronous ledger/stock posting, ADR-005 Server-authoritative offline sync.

## Bounded contexts (src/)
| Module | Owns | Facade exports |
|---|---|---|
| platform | outbox, audit, idempotency, alerts | OutboxService, AuditService, IdempotencyService |
| identity | users, JWT, pin-elevate override tokens | JwtModule |
| catalog | medicine master data (no quantities) | — |
| inventory | batches, FEFO, GRN, movements | InventoryService |
| sales | the atomic sale tx + offline sync replay | — |
| finance | journal, AR/AP subledgers, periods | LedgerService |
| customers | profiles, allergies, projections | — |
| pharmacy-ops | DUR deterministic rules engine | DurService |
| reporting | dashboard read model | — |

**Boundary rule:** cross-module calls go through exported facades inside the caller's
transaction (`Tx`). No module touches another module's tables.

## The atomic sale (sales/sales.service.ts)
ONE transaction: DUR gate → FEFO allocation (`SELECT … FOR UPDATE`, expired/quarantined
structurally excluded) → invoice + batch allocations (batch-mandatory) → append-only
inventory movements → balanced journal entry (Cash/AR + discount contra = Sales; COGS =
Inventory at batch cost) → AR cached-balance refresh → audit → outbox events.
Async consumers handle loyalty, projections, and low-stock alerts.

## Database invariants (prisma/sql/001_invariants.sql — part of the migration)
Append-only triggers (journal, movements, allocations, audit) · deferred Σdebit=Σcredit
trigger · CHECK quantityOnHand ≥ 0 · closed-period posting block · RLS tenant policies.

## Redis (optional tier — Plan §0)
Roles: single-use override tokens (R-1) · login rate limiting (R-2) · dashboard/stock
read-through caches invalidated by outbox consumers (R-3). With `REDIS_URL` unset or
Redis down the API **degrades gracefully and stays fully correct**: caches no-op,
rate limits open, override tokens validate by 120s JWT alone. Redis is never a source
of truth — outbox, idempotency, ledger, and stock remain in PostgreSQL.

## Returns (WF-3)
`POST /sales/returns` — one ACID tx: per-line over-return validation, RETURN_IN
restock into the original allocated batches (deterministic unit→allocation mapping;
expired/depleted lots return quarantined), contra journal `DR Sales / CR Discount /
CR Cash|AR` + `DR Inventory / CR COGS` at original cost, AR refresh, `SaleReturned`.

## Run
```bash
cp .env.example .env            # DATABASE_URL, JWT_SECRET
npm install
npx prisma migrate dev          # creates schema
psql $DATABASE_URL -f prisma/sql/001_invariants.sql
npm run seed                    # first tenant + chart of accounts
npm run start:dev               # http://localhost:3000/api/v1
```

Contract checks built in: `{data,meta}` envelope, `{error:{code,…}}` filter,
Decimal→string(4dp) serialization, mandatory `Idempotency-Key` on /sales, /sales/sync,
/inventory/grn, /finance/payments, `whitelist:true` validation strips any client-sent
`pharmacy_id`, override tokens are 120-second pharmacist-scoped JWTs.
