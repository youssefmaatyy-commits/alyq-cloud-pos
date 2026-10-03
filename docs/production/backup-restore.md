# Backup, restore and recovery

No production backup or restore has been performed by this repository preparation.

## Mandatory pre-migration backup record

Before touching Production, record: UTC timestamp, immutable backup ID, project/database ID, release SHA, current migration maximum, responsible operator, verifier, encrypted restore location, retention expiry, Storage export ID, environment/config inventory ID and rollback decision deadline.

1. Put application changes on hold; do not stop reads unless the provider procedure requires it.
2. Create a provider-supported PostgreSQL backup/snapshot that covers schema and data. Also export the migration ledger and critical auth-user references permitted by the provider.
3. Export `storage.objects` metadata and copy every `product-images` object to encrypted, access-controlled object storage while preserving paths, checksums, content types and cache metadata.
4. Export a redacted configuration inventory: Auth URLs/providers, Storage bucket settings/policies, Realtime publications, edge-function versions and secret **names/versions only**.
5. Verify backup completion, size, checksums/catalog readability and restore eligibility with a second operator.
6. Retain according to legal/business policy; never let this runbook invent a retention duration.

The migration cannot start until the verifier can identify the restore source and rollback authority.

## Restore drill (staging, mandatory before Go-Live)

Restore the production-like snapshot into a new isolated project/database. Restore objects and metadata, configure staging-only secrets, then verify login, branch switch, product/gallery, exact branch stock, historical invoice/payment/return, audit history, register records, schema Health and migration maximum. Apply pending migrations there, repeat verification, and record elapsed time and data-loss window.

RPO and RTO are **UNKNOWN until this drill and provider guarantees are measured**. Business owners must approve measured targets.

## Recovery procedures

### Migration failure

Stop immediately; keep the application at the prior compatible version. Capture failed migration/error and current transaction state. Most migration files use transactional/idempotent patterns, but the operator must verify whether the failed statement committed. Never continue to later files blindly. If state is not provably safe and compatible, restore the verified pre-migration snapshot into the approved recovery target and re-point only through the provider's controlled process.

### Bad Web release

Restore the prior immutable Web artifact/config, purge only HTML/bootstrap cache as required, and verify schema compatibility. Do not roll the database back merely to fix a frontend regression.

### Desktop release

Retain the prior signed installer and checksum. Stop rollout, uninstall/replace with the prior signed version without deleting `userData`, then verify register and outbox compatibility. Never replay an outbox with an incompatible schema.

### Mobile release

Stop staged rollout. Store rollback may be delayed or impossible for already-installed versions; use provider rollout controls, server-side compatibility and, only if designed in advance, a kill switch that does not bypass auth. Submit a corrected signed build. Database changes must remain backward-compatible across the supported mobile window.

### Storage/Auth issue

Restore missing objects at identical paths/checksums or roll back policy/config through reviewed provider controls. For Auth, restore redirect/provider configuration first; do not overwrite user records casually.

## Rollback triggers

Any migration ambiguity, RLS bypass, cross-branch disclosure, financial mismatch, failed restore verification, secret exposure, unavailable critical Health dependency or incompatible client requires NO-GO and recovery escalation.