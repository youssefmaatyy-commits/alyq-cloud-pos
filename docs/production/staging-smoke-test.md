# Staging and smoke-test plan

## Environment

Use a separate Supabase project/database, Storage bucket contents, Auth users, secrets, Web URL, Desktop registrations and push provider environment. Mirror production migrations/policies/configuration while using unmistakably non-production names. Never point destructive QA or cleanup at Production.

Build staging artifacts from the same frozen SHA with staging-only client-safe values. Use a test Windows register and test Android/iOS apps with separate signing/provider configuration where possible.

## Restore drill

1. Restore a production-like backup into isolated staging.
2. Verify pre-migration counts/checksums and historical evidence.
3. Apply pending migrations through `0085_first_admin_bootstrap.sql` using the exact operator procedure.
4. Verify users/roles, branches, variants, branch balances, registers, installations, invoices/returns and audit survive.
5. Record RPO/RTO measurements and restore/migration logs.

## Executable smoke checklist

- [ ] Login, refresh, logout and revoked-session refusal.
- [ ] Owner and restricted-user permission boundaries.
- [ ] Main → Branch B → Main switch with no stale authoritative data.
- [ ] Product and color gallery; exact Black/42 SKU/barcode/stock.
- [ ] Authorized adjustment and transfer; unauthorized attempts denied.
- [ ] Desktop register binding and shift open.
- [ ] Cash, card/InstaPay and split sale; invoice/reprint.
- [ ] Exact partial return, refund ceiling and rejected refund reporting.
- [ ] Delivery and pickup order; valid/invalid transition; cancellation reason.
- [ ] Approval approve/reject/replay/wrong-branch/expired paths.
- [ ] Offline cash sale, restart, reconnect, idempotency and conflict visibility.
- [ ] Sync Center redaction and Health truthful status.
- [ ] Mobile dashboard/order/inventory/approval action and deep-link denial.
- [ ] Storage upload/read/replace/delete; anon proof insert-only and no listing.
- [ ] Realtime refresh without duplicate notifications.
- [ ] Audit evidence and no secret values.

Any financial mismatch, branch leak, permission bypass, duplicate replay or secret exposure is an immediate NO-GO.