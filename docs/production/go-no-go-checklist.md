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