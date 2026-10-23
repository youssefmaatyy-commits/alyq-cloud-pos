# Notification 0099 rollout, verification and rollback

## Scope and hard gates

This runbook covers only the notification reliability update in
`0099_notification_reliability_and_dispatch.sql` and `alyq-push`. It does not
change the storefront design/cart/checkout contract, Windows/Android/iOS
artifacts, inventory rules, or Production data.

**Production is still an approval gate.** Applying the migration, installing an
extension, deploying/changing a worker, writing Vault/Edge secrets, enabling a
scheduler, changing Vercel/env settings, creating test data, or invoking a
dispatcher on Production each requires the corresponding explicit approval.
Do not copy the Staging operations into Production as one unattended script.

Never place a VAPID private key, dispatch bearer, service-role key, provider
key, customer/payment data, PIN, subscription endpoint/key, or raw token in a
browser variable, notification payload, ticket, terminal transcript, or log.
The Vault procedure below generates the dispatch bearer inside PostgreSQL and
does not return it. The worker's opt-in bootstrap generates VAPID inside the
worker and stores it through a compare-before-install RPC.

## Resulting behavior

- A successful online order creates its durable Outbox fact and immediately
  expands authorized Notification Center rows. Dispatcher availability is not
  a prerequisite for Inbox visibility.
- Creation, first/changed payment proof, and proof resubmission after payment
  rejection have stable event identities. Retrying identical proof does not
  create another alert, even though the official RPC refreshes its timestamp.
- Alert copy contains only the order number and attention type. The existing
  authorized resolver maps Web `order` to `/dashboard/online/orders/<uuid>`.
- Critical stock alerts require a fresh threshold crossing and a current
  critical balance. A balance that recovered before deferred expansion is
  discarded. Deleted-target history retains Inbox but cannot create Push.
- Only a positive unresolved offline-conflict transition alerts; pending
  offline work and repeated identical heartbeats do not.
- Per-kind controls filter device Push only, never the independent Inbox.
  Disabling a kind does not release old suppressed deliveries when re-enabled.
- Retry keeps the same delivery identity and appends attempt evidence. Current
  recipient, branch, capability, route, subscription, and preference authority
  is rechecked before claim.

## Staging evidence — 2026-10-23

Staging project `bubvtxctwqsfohrkenej` was used. Production was not modified.

1. Migration 0099 is registered, health reports migration 0099, the new
   functions/triggers exist, and `user_notification_inbox` is published to
   `supabase_realtime`.
2. A real `place_online_order` call created synthetic `WEB-000006`; the same
   `client_ref` returned `duplicate=true` with one order row. Before any worker
   invocation there was one order event, two authorized Inbox rows, and zero
   deliveries. RLS visibility and `notification_center_resolve_route` returned
   the correct order ID and `route_key=order` for the authorized test admin.
3. Staging testing exposed and fixed a real duplicate-proof edge case. Final
   evidence was one creation event plus exactly three payment-attention events
   for first proof, changed reference, and resubmission after rejection;
   identical retry and rejection added none. No reference, customer name, or
   phone appeared in notification copy.
4. The synthetic order was cancelled through the official RPC and its test
   order/events/reservations were removed. The variant remained at stock 3 and
   no reservation or synthetic Outbox row remained.
5. Transactional stock/sync tests passed and rolled back: two genuine stock
   crossings, no duplicate heartbeat, resolved-before-expansion discard, two
   genuine conflict cycles, and no pending-only alert. Post-rollback quantity,
   reorder level, register count, and event count were verified.
6. `alyq-push` is ACTIVE with gateway JWT verification disabled. An invalid
   bearer returned HTTP 403/`forbidden`, created no VAPID and claimed nothing.
   The authorized database dispatcher returned HTTP 200 with `claimed=0`, all
   outcomes zero, and `record_failures=0`; it expanded the one pre-existing
   Staging event into two Inbox rows and no deliveries.
7. Vault contains one valid public/private VAPID pair and the expected Staging
   subject. The authenticated public RPC exposes exactly one field,
   `public_key`, with length 87. The temporary `PUSH_VAULT_BOOTSTRAP` setting
   was removed after success.
8. Final Staging safety state: zero active native Push installations, zero
   active Web subscriptions, zero pending Outbox events, zero deliveries, zero
   queued `pg_net` requests, and **zero cron jobs** named
   `alyq-push-dispatch`. `pg_net` 0.20.4 is installed; cron remains off while
   there is no designated test device.

No real notification was sent or received. Physical Windows Chrome, Android
Chrome, and iPhone/iPad Home Screen delivery remain untested.

## Validation commands

Use the repository commands directly; do not substitute a database reset or a
previously prohibited database command.

```bash
npm run typecheck
npm test
node scripts/migrations.check.mjs --driver=pglite
npm run build
npm run test:e2e -- auth storefront-v2
node scripts/production-preflight.mjs --allow-dirty   # development only
```

Before release, run `node scripts/production-preflight.mjs` without
`--allow-dirty` from the committed SHA. The notification Chromium harness uses
an explicitly mocked permission getter because this sandbox's Chromium cannot
provide a trustworthy physical permission result. It must not be reported as a
real subscription, device test, or provider receipt.

## Staging deployment procedure used

### 1. Deploy the worker without a gateway JWT assumption

Deploy `supabase/functions/alyq-push` with `verify_jwt=false`; the handler
performs its own dedicated-bearer check and rejects the service-role key as
invocation authority. The runtime type-only `edge-runtime.d.ts` side-effect
import is intentionally absent: the Staging Management deployment proved that
import caused `BOOT_ERROR`, while the same worker without it booted and passed
its authorization checks.

Set only non-secret configuration through protected Edge settings:

```text
PUSH_CONFIG_SOURCE=vault
PUSH_VAULT_BOOTSTRAP=1    # one authorized bootstrap invocation only
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` remain Supabase-managed server
configuration. Never copy their values into scheduler headers or browser env.

### 2. Create dispatcher configuration without printing the bearer

Substitute only the Staging project URL. Run as an authorized database
operator, and do not `SELECT` the secret columns afterward:

```sql
do $alyq_dispatch$
declare
  v_url text := 'https://<project-ref>.supabase.co/functions/v1/alyq-push';
begin
  perform pg_advisory_xact_lock(hashtext('alyq-dispatch-bootstrap'));
  if exists(select 1 from vault.decrypted_secrets
             where name='ALYQ_PUSH_DISPATCH_URL' and decrypted_secret<>v_url) then
    raise exception 'Dispatcher URL differs; refusing rotation';
  end if;
  if not exists(select 1 from vault.decrypted_secrets
                 where name='ALYQ_PUSH_DISPATCH_URL') then
    perform vault.create_secret(v_url,'ALYQ_PUSH_DISPATCH_URL','ALYQ dispatcher endpoint');
  end if;
  if not exists(select 1 from vault.decrypted_secrets
                 where name='ALYQ_PUSH_DISPATCH_SECRET') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32),'hex'),
      'ALYQ_PUSH_DISPATCH_SECRET','ALYQ dedicated dispatcher bearer');
  end if;
end
$alyq_dispatch$;
```

Validate only counts/lengths and the expected URL. Enable `pg_net` only as its
own approved operation:

```sql
create extension if not exists pg_net;
```

### 3. Test authorization before authorized dispatch

Queue a request with an intentionally invalid bearer and inspect only HTTP
status/body. Require 403, zero VAPID entries, zero claims, and no new delivery.
Then run:

```sql
select public.notification_push_dispatch();
```

Inspect the `net._http_response` status and aggregate JSON. Require 200,
`record_failures=0`, and the expected claim count. With no registered test
device the required claim count is zero; this is not a Push receipt.

After the first successful bootstrap, remove `PUSH_VAULT_BOOTSTRAP`. Verify
that the public RPC has only `public_key`; never query/print the private value.
Leave cron off until the device/queue review is complete.

## Production plan — every operational step remains gated

1. Record explicit approval, backup/restore evidence, current migration health,
   pending Outbox/delivery counts, and active native/Web subscription counts.
2. Apply migration 0099 through the normal reviewed migration pipeline. Verify
   health 0099, function/grant/trigger parity, publication, and the stock
   quarantine counts. Do not enable a worker or scheduler as a side effect.
3. Deploy the worker separately. Existing Production Edge-secret configuration
   remains supported; do not move it to Vault or rotate VAPID as an incidental
   step. If Vault is approved, configure all required names atomically and keep
   the existing public VAPID key so current browser subscriptions are not
   invalidated.
4. Install `pg_net` only with extension approval. Generate/configure the
   dedicated dispatcher bearer in protected custody, never in chat or CI logs.
5. Before any manual invocation, inspect every pending event and every delivery
   that could be claimed. Stop if a test could reach a real employee device.
   Production synthetic orders/notifications are not an accepted substitute
   for the Staging tests.
6. Require a designated test-device plan and an observed provider/device result
   before calling physical delivery verified. Keep unavailable platforms
   explicitly untested rather than inferring success from HTTP 200/`claimed=0`.
7. Only after separate scheduler approval, create the one-minute job:

```sql
select cron.schedule(
  'alyq-push-dispatch',
  '* * * * *',
  $$select public.notification_push_dispatch();$$
);
```

Verify there is exactly one job, bounded responses, no growing queue, no
unexpected recipients, and no secret-bearing log output.

## Production critical-stock backlog policy

The read-only Production audit found **17 pending events / 17 balances: 11
still critical, 5 resolved, 1 missing**. They are historical backlog, not 17
new alerts. The approved policy is:

- Quarantine pending critical-stock facts older than 15 minutes as
  `stale_stock_quarantined_0099`; do not expand, requeue, or bulk-send them.
- Preserve the rows as dead-letter evidence for review. Do not delete them as
  part of rollout or rollback.
- The five resolved balances require no alert. The missing balance requires a
  separate data-integrity review, not a fabricated product notification.
- The eleven still-critical balances require inventory/staff review. If staff
  wants a fresh alert, a real new threshold crossing after the review creates
  a new stable event. Never manually turn the old rows back into a batch.
- Applying 0099 on Production must be followed by a count-only verification:
  17 quarantined, zero historical Inbox expansion, zero historical deliveries.
  Any different count stops dispatcher rollout.

No Production backlog row was changed during Staging work.

## Rollback and incident containment

1. **Stop invocation first:** unschedule `alyq-push-dispatch` if it exists and
   verify no `pg_net` request is queued. Do not drop `pg_net`/`pg_cron`; other
   workloads may share them.
2. Keep browser access revoked from dispatcher/Vault functions. If necessary,
   disable the worker or remove its non-secret Vault source setting through
   protected operations. Do not rotate/delete VAPID while subscriptions depend
   on it; key deletion is a separate subscription-migration operation.
3. Preserve Inbox, Outbox, delivery attempts, audit rows, and quarantined stock
   evidence. Never resolve an incident by requeueing all dead/pending rows.
4. For code rollback, deploy the last reviewed worker and apply a new reviewed
   forward repair migration that restores the 0092/0094 behavior for:
   `notify_new_online_order`, `notify_critical_stock`,
   `notify_offline_sync_failure`, `notification_expand_outbox`,
   `notification_process_outbox`, and `notification_claim_push_batch`.
   Remove the immediate-expansion trigger only in that repair migration. Do not
   replay the whole old migration set or reset health/migration history.
5. Validate authorized order visibility, Inbox, deep-link refusal, subscriptions,
   and queue counts before re-enabling anything. A dispatcher rollback does not
   require deleting the additive preferences table or notification evidence.

## Remaining acceptance gates

- Real subscription and visual/audible receipt on an available Windows Chrome
  test device.
- Real subscription/receipt and deep link on an available Android Chrome test
  device.
- Home Screen installation, permission, receipt, and deep link on an available
  physical iPhone/iPad; Safari-tab-only behavior is separately covered by UI
  tests and must not be claimed as installed-PWA delivery.
- A controlled provider outage/recovery observation on designated test devices;
  SQL retry identity tests are necessary but not a physical receipt.
- Clean committed preflight, CI checks, PR review, and every Production approval
  listed above.
