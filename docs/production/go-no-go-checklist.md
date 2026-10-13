# Production Go / No-Go checklist

All mandatory launch-scope items must have evidence. This preparation phase intentionally leaves them unchecked.

## Data and backend

- [ ] Production project identity independently confirmed.
- [ ] Verified production database/Storage/configuration backup recorded.
- [ ] Isolated restore drill passed; measured RPO/RTO accepted.
- [ ] Hosted migrations applied successfully through approved maximum.
- [ ] Production RLS, RPC grants, branch isolation and security verification passed.
- [ ] Auth URLs/providers/session behavior verified.
- [ ] Storage bucket, MIME limits, policies, CORS and backup verified.

## Releases

- [ ] Frozen SHA and complete release manifest approved.
- [ ] Full gate green twice; all 31 E2E suites pass on each run without skips/relaxed assertions.
- [ ] Exact-SHA PR CI checks (`Types & build`, `Logic suites`, `Migrations & schema`, `E2E (jsdom)`, `Release gate`) green.
- [ ] Main branch protections, independent environment reviewers/prevent-self-review and exact main-only deployment policy evidenced.
- [ ] Vercel automatic Git Production/domain promotion disabled; manual/dashboard/hook bypass paths controlled.
- [ ] Explicit Production mode/backend pair and final artifact SHA/time/environment/integrity/secret scan verified.
- [ ] Real anonymous read-only catalogue/pricing probe passed; no fake production seed.
- [ ] Empty-store exception, if used for new/staging only, explicitly approved and recorded.
- [ ] Failed-check/stale-SHA/unprotected-environment/empty-catalogue staging drill prevented domain movement.
- [ ] Served immutable candidate and authenticated Health release identity match the approved commit.
- [ ] Production Web smoke test passed over HTTPS with headers/CSP.
- [ ] Signed Windows installer built; publisher, timestamp and checksum verified.
- [ ] Prior Web/Desktop rollback artifacts are available.
- [ ] Android signed release build tested if launching Android.
- [ ] iOS signed release build tested if launching iOS.
- [ ] App/Universal Links verified on real devices.
- [ ] APNs/FCM provider delivery and safe payload verified if push is enabled.

## Store operations

- [ ] Real barcode scanner tested.
- [ ] Required 80mm and/or 58mm printer tested.
- [ ] Arabic physical receipt tested.
- [ ] Cash drawer policy and failure behavior tested.
- [ ] Offline/restart/reconnect tested on the real workstation.
- [ ] Register/branch/shift and cash reconciliation accepted.

## Operations

- [ ] Health checks are acceptable; unknown facts have explicit owners.
- [ ] Monitoring, incident contacts and observation window are active.
- [ ] No open BLOCKER/HIGH defect.
- [ ] Remaining npm/build-tool risk accepted by release owner.
- [ ] Rollback operator, backup and runbook are ready.
- [ ] Business owner and technical owner signed GO.

Any unchecked launch-scope item means **NO-GO**. Readiness of documentation is not evidence that an operational step occurred.
Release-control configuration and current external blockers: [`vercel-release-gate.md`](vercel-release-gate.md). Code changes/CI colors alone do not complete these administrator gates.
