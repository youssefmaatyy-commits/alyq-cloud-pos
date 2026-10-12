# Controlled Go-Live runbook — do not execute without authorization

Every step requires recorded evidence and an assigned operator. Stop on uncertainty.

1. Freeze approved Git SHA, release manifest and platform versions; ensure clean signed artifacts.
2. Confirm production project identity with a second operator and freeze changes.
3. Create database, Storage and configuration backups; record IDs/checksums.
4. Confirm isolated restore drill passed and rollback authority is present.
5. Put incompatible application versions on hold; record current migration maximum.
6. Apply only reviewed pending migrations in numeric order. Stop on first error.
7. Verify migration maximum, schema/RPC parity, RLS, grants, branch isolation and audit append-only behavior.
8. Verify Auth Site URL/redirects/provider settings and Storage bucket/policies/MIME/limits.
9. Follow `vercel-release-gate.md`: verify required exact-SHA checks, protected environment/branch policy and disabled independent Vercel Git Production path; validate explicit Production mode/final artifact, run the real read-only public catalogue probe, stage a no-domain immutable candidate, verify its served release identity, then promote only with approval. Do not change DNS until separately approved.
10. Verify authenticated Health SHA/UTC timestamp/environment against the approved release. Run business smoke checks only under the separately authorized operational acceptance plan; never seed fake products or run mutation fixtures against Production to manufacture a passing probe.
11. Install the signed Desktop artifact on the acceptance workstation; verify publisher, timestamp and checksum.
12. Bind the real register, open a controlled shift and verify register/branch/user separation.
13. Complete scanner, 80/58mm, Arabic printer and drawer acceptance.
14. Perform a low-value controlled sale/refund according to business approval; reconcile evidence.
15. Verify offline cash sale/restart/reconnect exactly once on the real workstation.
16. Validate signed Android/iOS builds on target devices before enabling distribution.
17. Validate App/Universal Links, push permission, safe payload and provider delivery if push launches.
18. Monitor Health, Auth, database errors, queue/conflicts, order flow and audit through the observation window.
19. Complete the Go/No-Go checklist. Only the named business and technical approvers may authorize opening.
20. Preserve release, backup, smoke, checksum and approval evidence.

This repository phase does not execute any step above.