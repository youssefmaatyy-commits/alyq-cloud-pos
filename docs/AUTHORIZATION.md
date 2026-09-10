# Authorization — completed work & authentication readiness

**Status: the authorization task is COMPLETE.** Audit-route access control is fixed and
verified; the role/permission model is centralised and parity-locked to the shipped
behaviour. **Authentication is a separate, not-yet-started phase** — the three
authentication steps in `scripts/auth.flow.mjs` are intentionally **pending**, not failures.

| | |
|---|---|
| Branch | `arena/01a08778-alyq-cloud-pos` |
| Completion commits | `2cf72be` audit access control · `4af0e72` role + capability model · `560d12e` role-switcher regression coverage · `bddfc70` authentication flow test |
| Verification | `tsc` clean · `npm run build` green · role-model 10/10 · Phase 8 16/16 · POS 34/34 · Returns 9/9 · full DOM E2E green, zero console errors · `auth.flow.mjs` 4 passed / 0 failed / 3 pending |

---

## 1. Completed authorization fixes

### 1.1 Audit route authorization (the reported gap)

**Gap:** `canViewAuditLog()` was written but never called. Any role — including `viewer` —
could open `#/audit` and read the entire shift and expense trail.

**Fix — `src/modules/audit/components/RequireAuditAccess.tsx` + `src/App.tsx`:**
- The `/audit` route is wrapped in a guard that renders a denial card instead of the trail.
- The guard reads the **reactive** acting user, so switching to a lower role while the page
  is open immediately replaces entries with the denial state — no stale view.
- `/audit` is the **only** entry point in the app (grep-verified) and the page is
  read-only, so there is no secondary path or mutating action to gate.
- Denial copy is bilingual (EN + AR): `audit.denied`, `audit.deniedHint`.

### 1.2 Navigation visibility

`src/components/layout/AppShell.tsx` hides the audit sidebar entry for roles without the
capability — matching how other permission-gated controls behave. The route stays guarded
independently, so hiding the link is cosmetic and never the only control.

### 1.3 Fail-closed role resolution

`normalizeRole()` returns `null` for any unknown, empty or unexpected role string, and
`hasCapability()` then denies everything. An unrecognised role from an external source can
never be silently treated as privileged.

### 1.4 Evidence

| Check | Result |
|---|---|
| Viewer, direct `#/audit` deep link | Denied; zero audit rows; no `EXP-` ids leak |
| Viewer, sidebar | No audit nav entry |
| Manager / admin | Trail renders normally |
| Viewer, blocked sale (clicked anyway) | Sales store and movement store both `null` — nothing written |
| Viewer, stock adjustment | Unavailable |
| Logic suites | Role model 10/10 · Phase 8 16/16 · POS 34/34 · Returns 9/9 |
| E2E | Green, zero console errors, incl. audit denial + role-switcher cycle |

### 1.5 Guarantee that nothing else changed

Since the last pre-Phase-8 commit (`888f9c2`), across `pos`, `returns`, `customers`,
`inventory`, `products`, `dashboard` and `lib/supabase` there are exactly **two** diffs:

- `src/modules/inventory/permissions.ts` — **4 lines, comment only** (pointer to the shared model).
- `src/modules/pos/services/receiptStrings.ts` — a **new file** whose imports were already
  referenced by previously committed receipt code; committed so a fresh clone builds.

No behavioural change to any shipped module. `INVENTORY_ROLES` / `ROLE_LABEL` and the demo
role switcher are untouched.

---

## 2. Current permission model

### 2.1 Single source of truth

`src/lib/permissions/roles.ts` owns *what a role may do*:

- **Five roles** (`APP_ROLES`, most privileged first):
  `admin`, `manager`, `cashier`, `inventory_clerk`, `viewer`.
- **Sixteen capabilities** (`CAPABILITIES`): `view_inventory`, `adjust_stock`, `sell`,
  `apply_discount`, `void_sale`, `confirm_payment`, `process_return`, `process_refund`,
  `open_shift`, `close_shift`, `add_expense`, `edit_expense`, `delete_expense`,
  `view_shifts`, `approve_shift_adjustment`, `view_audit_log`.
- **`ROLE_CAPABILITIES`** — the role → capability matrix (section 2.2).
- **`normalizeRole` / `isAppRole`** — external & legacy aliases map onto the model
  (`owner`, `super_admin`, `superadmin` → admin; `clerk`, `stock_clerk` → inventory_clerk;
  `auditor` → viewer; case- and whitespace-tolerant). Unknown → `null` → deny.
- **`hasCapability`** — the one question every gate asks; fails closed.
- **`capabilitiesOf` / `rolesWithCapability`** — for future admin screens and tests.

### 2.2 Role × capability matrix

| Capability | Admin | Manager | Cashier | Inventory Clerk | Viewer |
|---|:--:|:--:|:--:|:--:|:--:|
| `view_inventory` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `adjust_stock` | ✓ | ✓ | — | ✓ | — |
| `sell` | ✓ | ✓ | ✓ | ✓ | — |
| `apply_discount` | ✓ | ✓ | — | — | — |
| `void_sale` | ✓ | ✓ | — | — | — |
| `confirm_payment` | ✓ | ✓ | ✓ | ✓ | — |
| `process_return` | ✓ | ✓ | ✓ | ✓ | — |
| `process_refund` | ✓ | ✓ | ✓ | ✓ | — |
| `open_shift` | ✓ | ✓ | ✓ | ✓ | — |
| `close_shift` | ✓ | ✓ | ✓ | ✓ | — |
| `add_expense` | ✓ | ✓ | ✓ | ✓ | — |
| `edit_expense` | ✓ | ✓ | — | — | — |
| `delete_expense` | ✓ | ✓ | — | — | — |
| `view_shifts` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `approve_shift_adjustment` | ✓ | ✓ | — | — | — |
| `view_audit_log` | ✓ | ✓ | — | — | — |

Intent: **admin/manager** are full-access oversight roles (identical today, split so one can
be narrowed later without touching call sites). **Cashier** runs the till and holds no
manager power. **Inventory clerk** = cashier + stock authority. **Viewer** is read-only.

### 2.3 How modules consume it

Per-module helpers keep their original names and signatures and delegate to the matrix:

- `src/modules/shifts/permissions.ts` — now pure delegation (`canOpenShift`, `canCloseShift`,
  `canAddExpense`, `canEditExpense`, `canDeleteExpense`, `canViewAllShifts`,
  `canApproveAdjustment`, `canViewAuditLog`).
- `src/modules/inventory/permissions.ts`, `src/modules/pos/permissions.ts`,
  `src/modules/returns/permissions.ts` — **unchanged**, still Phase-3/4/7 code. They are the
  parity reference: the role-model suite asserts capability-by-capability, role-by-role that
  the matrix reproduces all 16 helpers for the four shipped roles.

### 2.4 Where each gate is enforced today

| Capability | Enforcement point | Layer |
|---|---|---|
| `view_audit_log` | `RequireAuditAccess` (route) + `AppShell` nav | Route + UI |
| `adjust_stock` | `InventoryProvider.adjustStock` + inventory page button | **Action + UI** |
| `sell` | `PosProvider.completeSale` (throws `FORBIDDEN`) + payment panel | **Action + UI** |
| `apply_discount` | `PosProvider.canDiscount` + cart discount control | UI |
| `confirm_payment` | Sale detail + sales history quick-confirm | UI |
| `void_sale` | Sale detail | UI |
| `process_return` / `process_refund` | Returns / refunds pages | UI |
| `open_shift` / `close_shift` / `add_expense` / `approve_shift_adjustment` / `view_shifts` | `ShiftProvider` context flags + shift screens | UI |
| `add_expense` / `edit_expense` / `delete_expense` | Expenses page controls | UI |

**The acting user today** comes from `src/modules/inventory/permissions.ts`
(`getCurrentUser()`, `localStorage["alyq.inventory.currentUser.v1"]`, fallback demo admin),
surfaced reactively through `InventoryProvider.user` and a **demo role switcher** on the
Inventory page offering the four shipped roles. **The `cashier` role exists in the model but
is not selectable in the UI yet.**

### 2.5 Changing the model

Edit `ROLE_CAPABILITIES` in one file. No call site changes. `roles.selftest.ts` will fail if
a shipped role's behaviour shifts, and `scripts/auth.flow.mjs` step 6 re-verifies the
user-visible consequences.

---

## 3. Remaining authentication requirements (next phase)

Not started. Listed here as the backlog for that phase.

### 3.1 Functional requirements

1. **Login screen** — a `#/login` route rendered *outside* the app shell (no sidebar, no
   module data loaded), email/username + password, show/hide, inline validation, bilingual
   EN/AR. Demo credentials surfaced on the card while running without Supabase.
2. **Credential verification** — Supabase `auth.signInWithPassword` in live mode; in demo
   mode a local credential store with passwords hashed in-browser (Web Crypto SHA-256, no
   new dependency). Wrong credentials must produce a clear error and no session.
3. **Session** — token issuance, persistence, refresh and an idle expiry (proposed default
   8 h), plus a decision on `localStorage` vs `sessionStorage`.
4. **Session guard** — `RequireAuth` around the shell, redirecting to `#/login?next=<route>`
   and returning there after sign-in. Anonymous deep links (e.g. `#/pos`, `#/audit`) must
   bounce; today only role guards exist.
5. **Logout** — a header control showing the acting name + role, and "Sign out": clear the
   session, return to the login screen, and make any subsequent deep link demand
   credentials again (no leftover identity).
6. **Profile → role mapping** — the session user's role arrives as a raw string and resolves
   through `normalizeRole` (fail closed onto `viewer`-like denial for anything unknown).
   In Supabase mode, the role lives in a `profiles` row keyed by the auth user id.
7. **Make `cashier` real** — assignable/selectable, and close the known POS gap:
   `canCompleteSale` does not accept `cashier` while the matrix says it should
   (pinned by an explicit assertion in `roles.selftest.ts` so it cannot be forgotten).
8. **Action-layer enforcement for the remaining modules** — today returns/refunds, expenses
   and shift actions are gated at the **UI only**; inventory and POS already check at the
   action layer. Once the acting user is authoritative, `createReturn`, expense
   add/edit/delete and shift open/close/approve must verify the capability server-side /
   action-side too.
9. **Audit events for authentication** — `auth.login`, `auth.login_failed`, `auth.logout`
   through the existing append-only audit module (actor, timestamp, details).
10. **Account management scope decision** — self-service password reset, invite/create user,
    and whether demo accounts are seeded on first boot.

### 3.2 Decisions to settle before/at the start of the phase

- Session lifetime and whether "remember me" exists.
- Fate of the demo role switcher once real accounts exist (keep as a demo aid, hide in live
  mode, or remove).
- Where the four demo accounts live and whether the `cashier` role is seeded alongside them.
- Password policy and lockout/throttling behaviour for failed sign-ins.

### 3.3 Acceptance test already wired

`scripts/auth.flow.mjs` runs the seven requested steps and reports PASS / PENDING / FAIL.
Flip `AUTH_IMPLEMENTED = true` when the phase lands: steps 2, 3 and 7 then assert for real
(login screen renders, credentials are submitted, sign-out returns to the login screen and a
post-logout deep link bounces), while steps 1, 4, 5 and 6 keep running as they do now.

```
npx esbuild src/main.tsx --bundle --format=esm --platform=node \
  --outfile=/tmp/alyq-app.mjs --loader:.css=empty \
  --define:import.meta.env='{"VITE_CURRENCY":"SAR"}'
node scripts/auth.flow.mjs
```

### 3.4 Environment constraint

Supabase is **not configured** in this environment, so only the demo credential path can be
verified end to end here; the Supabase path must follow the existing
`isSupabaseConfigured` / repository split used by every other module and will need a
live-credential review before it can be called verified.

---

## 4. Reproducing the verification

```bash
# typecheck + production build
npx tsc --noEmit
npm run build

# logic suites
npx esbuild src/lib/permissions/__tests__/roles.selftest.ts --bundle --format=esm \
  --platform=node --outfile=/tmp/alyq-roles.mjs && node /tmp/alyq-roles.mjs   # 10/10
npx esbuild src/modules/shifts/__tests__/logic.selftest.ts --bundle --format=esm \
  --platform=node --outfile=/tmp/alyq-phase8.mjs && node /tmp/alyq-phase8.mjs  # 16/16
npx esbuild src/modules/pos/__tests__/logic.selftest.ts --bundle --format=esm \
  --platform=node --outfile=/tmp/pos-logic.mjs && node /tmp/pos-logic.mjs      # 34/34
npx esbuild src/modules/returns/__tests__/logic.selftest.ts --bundle --format=esm \
  --platform=node --outfile=/tmp/ret-logic.mjs && node /tmp/ret-logic.mjs      # 9/9

# full DOM smoke suite (Products → Inventory → POS → Customers → Returns → Shifts → RTL)
npx esbuild src/main.tsx --bundle --format=esm --platform=node \
  --outfile=/tmp/alyq-app.mjs --loader:.css=empty \
  --define:import.meta.env='{"VITE_CURRENCY":"SAR"}'
node scripts/smoke.dom.mjs

# seven-step authentication flow report
node scripts/auth.flow.mjs
```
