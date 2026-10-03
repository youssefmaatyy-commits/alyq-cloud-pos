# Production rollback runbook

Rollback is selected by the release authority; database recovery is not assumed to be a down migration.

## Immediate containment

Stop rollout and new artifact distribution, preserve logs/audit, identify affected release/SHA/migration, and communicate the customer/store impact. Do not delete queues, retry blindly or modify financial rows manually.

## Decision paths

### Migration failure or incompatible data

Stop at the failed file. Determine whether its transaction committed and compare migration/schema state. If the prior app is schema-compatible, hold/revert clients while investigating. If the database is partial, corrupt or incompatible, restore the verified pre-migration snapshot into the approved recovery target and verify Auth references, Storage metadata, branch stock, financial history and audit before cutover. Never improvise destructive reverse SQL.

### Web regression

Redeploy the prior immutable artifact and matching client-safe configuration; invalidate HTML/bootstrap cache only. Verify backend/schema compatibility and smoke tests.

### Desktop regression

Stop installer rollout. Verify and reinstall the prior signed installer without deleting `userData`; preserve register credential and outbox. Block sync if schema/evidence is incompatible, then reconcile under the documented conflict process.

### Mobile regression

Pause phased release. Use store rollback controls where available, but assume installed builds cannot be recalled. Keep server APIs backward-compatible, disable only predesigned optional functionality, and issue a corrected signed build. Never bypass authorization through a remote flag.

### Storage regression

Restore objects at original paths/checksums and restore reviewed policies/configuration. Reconcile database URL references and orphan reports; do not make proofs enumerable as a shortcut.

### Auth regression

Restore known redirect/provider/session configuration. Revoke exposed sessions if required. Do not reset or recreate staff accounts without identity/audit reconciliation.

## Exit criteria

Recovery is complete only after migration/schema state, login, branch isolation, exact stock, historical invoice/return, audit, register/outbox and Health checks pass and the incident/recovery record names approvers and evidence.