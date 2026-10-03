# ALYQ production architecture

Status: preparation only; this document does not authorize deployment.

## Components and authority

| Component | Production responsibility | Authority |
|---|---|---|
| Web React/Vite bundle | Admin, storefront, POS-capable web UI | Presentation only; never authorization |
| Supabase Auth | Staff identity, sessions, refresh and revocation | Identity authority |
| PostgreSQL | Products, exact variants, branches, stock, orders, sales, returns, shifts, approvals, registers, audit | Business-data authority |
| RLS + normalized `can()` | Row visibility, branch membership and capability enforcement | Access authority |
| Security-definer RPCs | Atomic checkout, POS, refund, stock, approval, cleanup and registration transitions | Mutation authority; each RPC must re-authorize |
| Supabase Storage | Public product/site images and UUID-named payment proofs in `product-images` | Object custody; Storage RLS controls listing/writes |
| Supabase Realtime | Invalidation/refresh signal | Never source of truth; clients re-read authoritative rows |
| Electron Desktop | Windows POS shell, secure IPC, register/hardware adapters | Device shell only |
| Desktop register records | Installation binding and register/branch evidence | PostgreSQL authority; credential proves binding, not user identity |
| IndexedDB outbox | Supported offline cash sale durability | Temporary client evidence; server replay is authoritative and idempotent |
| Sync Center | Queue/conflict visibility and retry control | Status surface only |
| Health Center | Truthful backend/schema/realtime/storage/register/queue facts | Observation only; unavailable stays unknown |
| Capacitor Mobile | Permission-driven management client for Android/iOS | Presentation/native lifecycle only |
| Mobile installations | Installation and push-token custody, separate from user/register | PostgreSQL/service-role delivery authority |
| Notifications | Stable operational `kind:entity` signals | Advisory; destination reads and permissions remain authoritative |
| Push worker/provider | Future server-side APNs/FCM delivery | Server-only credentials; not implemented in clients |

## Trust boundaries

The browser, Electron renderer, WebView, URL/deep link, realtime message and push payload are untrusted inputs. Branch IDs, user IDs, prices, discounts, register IDs and approval evidence are re-derived or verified by RLS/RPCs. Desktop preload exposes a narrow allowlisted bridge; Mobile exposes only reviewed Capacitor plugins. No second backend or parallel account system is permitted.

## Domain ownership

- Catalogue and galleries: PostgreSQL plus `product-images` object URLs.
- Branch stock: `branch_stock_balances` and atomic movement RPCs; aggregate product stock is compatibility data.
- Orders: checkout/resolve RPCs and order events.
- Financial history: sales, payment allocations, returns/refunds and immutable snapshots.
- Cash: shift and cash-movement RPCs.
- Oversight: approval fingerprints and append-only audit.
- Offline: original client evidence is retained; only server acknowledgement creates authority.

See `supabase-production-checklist.md`, `production-environment.md`, and the release/rollback runbooks before any release.