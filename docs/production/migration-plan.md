# Production migration plan — 0001 through 0083

This is an operator plan, not evidence of hosted execution. The repository contains 83 contiguous forward migrations from `0001_create_categories.sql` through `0083_mobile_installations_and_push.sql`. Historical files must not be edited.

## Determine the exact pending range

1. Freeze the approved Git SHA and independently confirm the Production project.
2. Export the provider migration ledger and schema before changing anything.
3. Compare every recorded migration name/checksum to this repository. **Stop on drift, gaps, renamed files, unknown later migrations, or a partially applied file.** Do not infer success from object existence alone.
4. If the target is empty, the exact ordered range is `0001`–`0083`.
5. If the target has a matching contiguous prefix ending at `NNNN`, the exact pending range is `NNNN+1`–`0083`.
6. If it already has a matching `0001`–`0083`, no database migration is pending. Never replay merely to create evidence.

## Mandatory execution sequence

- Complete the verified database, Storage and configuration backup plus isolated restore drill.
- Prove the pending range on staging restored from production-like data.
- Keep the prior compatible clients available and assign stop/rollback authority.
- Apply each pending file in numeric order with stop-on-error and transaction semantics. Record filename, checksum, start/end UTC, outcome and operator.
- Stop on the first error. Do not run later files and do not mark a failed file applied manually.
- After success, re-export the ledger and verify maximum `0083_mobile_installations_and_push.sql`, expected schema/RPC parity, RLS/grants, branch isolation, audit append-only behavior and staging smoke tests.

## Dry-run evidence from preparation

On 2026-10-03, `npm run db:check` applied all 83 migrations to a fresh in-process PostgreSQL-compatible PGlite database, then reapplied all 83 to test idempotency. Role/RLS, focused branch/approval/cleanup/inventory/register/mobile scenarios, Final Store QA, seed idempotency and application schema parity all passed.

A separate disposable PGlite probe deliberately created a table and row inside a transaction, raised a division-by-zero failure, rolled back, and confirmed `to_regclass(...)` was null. This verifies the local transaction/failure harness. It does **not** replace a real PostgreSQL/Supabase staging rehearsal or prove every provider operation is transactional.

## Failure recovery

Capture the error and transaction status without retrying. If the failed file rolled back fully, leave clients on the prior compatible version, correct the defect only through a new reviewed forward migration after staging rehearsal, and restart under a new approval. If state is ambiguous, partially committed or incompatible, invoke `backup-restore.md` and `rollback-runbook.md`; do not improvise reverse SQL.
