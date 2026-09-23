# Permission matrix — capability → module → guard → database

Generated for Phase 19 QA from `roles.ts`, `catalog.ts`, `routes.ts`, `actions.ts` and the 29 migrations in `supabase/migrations`. Every row is checked by `src/lib/permissions/__tests__/`; this file is the readable form of what those tests pin.

**45 capabilities · 47 registered sensitive actions · 23 gated routes · 5 roles.**

Three layers decide every act, and a row is only complete when all three agree:

1. **UI** — the sidebar and the control: `ROUTE_CAPABILITIES` for screens, `canAct()` for buttons.
2. **Service** — the exported guard the register names, called before any write. This is the layer that refuses a direct call.
3. **Database** — `public.can()` inside the RPC, or an RLS policy, or no write path at all. In live mode this is the authoritative one.

| Capability | Module (group) | Gated route(s) | Service guard(s) | Database protection | admin | mgr | cashier | clerk | viewer |
|---|---|---|---|---|:-:|:-:|:-:|:-:|:-:|
| `view_inventory` | inventory | `/inventory/movements`<br>`/inventory` | — | public.can('view_inventory') in 0017×1 | ✓ | ✓ | ✓ | ✓ | ✓ |
| `adjust_stock` | inventory | — | `assertCanAdjustStock` <sub>stock.adjust</sub><br>`assertCanCorrectStock` <sub>stock.correct</sub><br>`assertCanRepairReservations` <sub>reservation.repair</sub> | public.inventory_adjust_stock — writes the movement and the product in one call | ✓ | ✓ | · | ✓ | · |
| `sell` | sales | `/pos/sales`<br>`/pos` | `assertCanCompleteSale` <sub>sale.complete</sub> | public.pos_complete_sale — reprices server-side; sales has no direct-write policy | ✓ | ✓ | ✓ | ✓ | · |
| `apply_discount` | sales | — | `assertCanDiscountSale` <sub>sale.discount</sub> | pos_complete_sale accepts a discount only from a caller public.can('apply_discount') allows | ✓ | ✓ | · | · | · |
| `void_sale` | sales | — | `assertCanVoidSale` <sub>sale.void</sub><br>`assertCanDeleteSale` <sub>sale.delete</sub> | public.pos_void_sale — restocks once, refuses an already-voided sale | ✓ | ✓ | · | · | · |
| `confirm_payment` | sales | — | `assertCanConfirmPayment` <sub>sale.confirm_payment</sub> | public.pos_confirm_payment — idempotent, never changes totals | ✓ | ✓ | ✓ | ✓ | · |
| `process_return` | returns | `/returns` | `assertCanCreateReturn` <sub>return.create</sub> | public.pos_process_return — restocks, caps at the sale's refundable amount | ✓ | ✓ | ✓ | ✓ | · |
| `process_refund` | returns | `/refunds` | `assertCanRecordRefund` <sub>refund.record</sub> | public.pos_process_return writes the refund row; refund_records has no direct write | ✓ | ✓ | ✓ | ✓ | · |
| `approve_refund` | returns | — | `assertCanSettleRefund` <sub>refund.settle</sub> | public.pos_settle_refund — pending → completed/rejected exactly once, one audit row | ✓ | ✓ | · | · | · |
| `open_shift` | shifts | — | `assertCanOpenShift` <sub>shift.open</sub> | public.open_shift — one open shift installation-wide | ✓ | ✓ | ✓ | ✓ | · |
| `close_shift` | shifts | — | `assertCanCloseShift` <sub>shift.close</sub> | public.close_shift — freezes the shift and stamps the summary | ✓ | ✓ | ✓ | ✓ | · |
| `add_expense` | expenses | — | `assertCanCreateExpense` <sub>expense.create</sub> | RLS insert on expenses — attribution stamped to the caller, immutable | ✓ | ✓ | ✓ | ✓ | · |
| `edit_expense` | expenses | — | `assertCanEditExpense` <sub>expense.edit</sub> | RLS update on expenses — manager rights only | ✓ | ✓ | · | · | · |
| `delete_expense` | expenses | — | `assertCanDeleteExpense` <sub>expense.delete</sub> | RLS delete on expenses — manager rights only | ✓ | ✓ | · | · | · |
| `view_shifts` | reports | `/shifts/history`<br>`/shifts`<br>`/expenses`<br>`/reports`<br>`/reports/advanced` | `assertCanViewShiftDifferences` <sub>shift.view_differences</sub> | RLS select on shifts — viewer and above; the cash difference is part of the row | ✓ | ✓ | ✓ | ✓ | ✓ |
| `approve_shift_adjustment` | shifts | — | `assertCanApproveShiftAdjustment` <sub>shift.approve_adjustment</sub> | public.approve_shift_adjustment — once only, manager rights | ✓ | ✓ | · | · | · |
| `view_audit_log` | settings | `/audit` | `assertCanViewAudit` <sub>audit.view</sub> | RLS select on audit_log — oversight roles only | ✓ | ✓ | · | · | · |
| `manage_online_orders` | online | `/online/orders`<br>`/online/reservations`<br>`/online/reports` | — | public.can('manage_online_orders') in 0017×6, 0018×1, 0020×1 | ✓ | ✓ | ✓ | ✓ | · |
| `manage_website` | online | `/online/website`<br>`/online/marketing`<br>`/online/content` | — | public.can('manage_website') in 0017×13, 0020×1 | ✓ | ✓ | · | · | · |
| `edit_sale` | sales | — | `assertCanEditSale` <sub>sale.edit</sub> | no write path — a completed sale is immutable; corrections go through returns or a void | ✓ | ✓ | · | · | · |
| `add_product` | products | — | `assertCanCreateProduct` <sub>product.create</sub><br>`assertCanCreateCategory` <sub>category.create</sub> | RLS insert on products — add_product | ✓ | ✓ | ✓ | ✓ | · |
| `edit_product` | products | — | `assertCanEditProduct` <sub>product.edit</sub><br>`assertCanEditCategory` <sub>category.edit</sub><br>`assertCanToggleProduct` <sub>product.activate</sub> | RLS update on products — edit_product | ✓ | ✓ | ✓ | ✓ | · |
| `change_price` | products | — | `assertCanChangePrice` <sub>product.price_change</sub> | RLS update on products — change_price is checked separately from edit_product | ✓ | ✓ | ✓ | ✓ | · |
| `delete_product` | products | — | `assertCanDeleteProduct` <sub>product.delete</sub><br>`assertCanDeleteCategory` <sub>category.delete</sub> | `public.delete_product` (0037) — counts references in sale_items / return_items / stock_movements / online_order_items / stock_reservations and refuses any product with a history (those are archived via `public.set_product_active`, an `edit_product` verb); RLS delete on categories | ✓ | ✓ | ✓ | ✓ | · |
| `import_data` | inventory | — | `assertCanImportStock` <sub>stock.import</sub><br>`assertCanImportProducts` <sub>product.import</sub> | each imported row is an inventory_adjust_stock call, so the RLS check applies per row | ✓ | ✓ | ✓ | ✓ | · |
| `export_data` | inventory | — | `assertCanExportData` <sub>data.export</sub><br>`assertCanRunEmergencyExport` <sub>backup.emergency_export</sub><br>`assertCanExportAudit` <sub>audit.export</sub> | as report.export — a bulk extract of the same RLS-filtered rows | ✓ | ✓ | ✓ | ✓ | ✓ |
| `approve_return` | returns | — | `assertCanApproveReturn` <sub>return.approve</sub><br>`assertCanRejectReturn` <sub>return.reject</sub> | public.pos_settle_refund(completed) — requires approve_refund, decides once | ✓ | ✓ | · | · | · |
| `view_reports` | reports | — | `assertCanViewReports` <sub>report.view</sub> | every report reads tables whose RLS already limits what the caller sees | ✓ | ✓ | ✓ | ✓ | ✓ |
| `export_reports` | reports | — | `assertCanExportReports` <sub>report.export</sub> | the export writes only rows the caller could already select | ✓ | ✓ | ✓ | ✓ | ✓ |
| `approve_expense` | expenses | — | `assertCanApproveExpense` <sub>expense.approve</sub> | public.expense_decide — requires approve_expense, decides once, writes audit | ✓ | ✓ | · | · | · |
| `manage_users` | settings | `/settings/users` | — | public.can('manage_users') in 0021×2, 0028×1 | ✓ | · | · | · | · |
| `manage_roles` | settings | `/settings/roles` | — | public.can('manage_roles') in 0021×4 | ✓ | · | · | · | · |
| `manage_settings` | settings | `/settings` | `assertCanEditApprovalRules` <sub>approval.rules</sub><br>`assertCanChangeBackupSchedule` <sub>backup.schedule</sub> | public.set_approval_rules — requires manage_settings, audits the before and after | ✓ | · | · | · | · |
| `approve_limit_request` | approvals | — | `assertCanDecideApproval` <sub>approval.decide</sub> | public.decide_approval_request — requires approve_limit_request, decides once, a rejection needs a note | ✓ | ✓ | · | · | · |
| `view_customers` | customers | `/customers` | — | public.can('view_customers') in 0028×1 | ✓ | ✓ | ✓ | ✓ | ✓ |
| `add_customer` | customers | — | — | public.can('add_customer') in 0028×1 | ✓ | ✓ | ✓ | ✓ | · |
| `edit_customer` | customers | — | — | public.can('edit_customer') in 0028×2 | ✓ | ✓ | ✓ | ✓ | · |
| `delete_customer` | customers | — | — | public.can('delete_customer') in 0028×1 | ✓ | ✓ | · | · | · |
| `view_cost` | products | — | — | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| `change_cost` | products | — | `assertCanChangeCost` <sub>product.cost_change</sub> | RLS update on products — a purchase cost is a price, and it drives every profit figure | ✓ | ✓ | ✓ | ✓ | · |
| `view_backups` | data_safety | `/settings/backup` | `assertCanViewBackups` <sub>backup.view</sub> | the backup_manifests view filters on public.can('view_backups'); public.backups has no select grant | ✓ | ✓ | · | · | · |
| `create_backup` | data_safety | — | `assertCanCreateBackup` <sub>backup.create</sub> | public.create_backup — requires create_backup, refuses kind 'pre_restore' | ✓ | ✓ | · | · | · |
| `restore_backup` | data_safety | — | `assertCanRestoreBackup` <sub>backup.restore</sub> | public.admin_restore_backup / admin_restore_document — requires restore_backup, one transaction, snapshots the current state first | ✓ | · | · | · | · |
| `export_backup` | data_safety | — | `assertCanExportBackup` <sub>backup.export</sub> | public.get_backup_document / snapshot_document — requires export_backup | ✓ | · | · | · | · |
| `run_health_check` | data_safety | — | `assertCanRunHealthCheck` <sub>backup.health_check</sub> | offline only — in live mode the check reads through snapshot_document(), so it also requires export_backup | ✓ | ✓ | · | · | · |

## Reading the gaps

- **No route and no registered guard (4):** `add_customer`, `edit_customer`, `delete_customer`, `view_cost` — enforced only inside the code path that uses it, or deliberately not screen-gated.
- **No literal `public.can('<cap>')` in SQL (17):** `sell`, `apply_discount`, `process_return`, `process_refund`, `edit_sale`, `add_product`, `edit_product`, `change_price`, `import_data`, `export_data`, `approve_return`, `view_reports`, `export_reports`, `approve_expense`, `view_cost`, `change_cost`, `run_health_check` — the database column above says what makes the refusal authoritative instead (a differently-named check, an RLS policy, or no write path).
- **Held by no role (0):** none — grantable from the Permission Builder, granted to nobody by default.

## Verified by hand (Phase 19)

The three gap lists above are generated, so each one was read against the code
before it was accepted as a gap or dismissed:

- **`add_customer`, `edit_customer`, `delete_customer`** — not in the
  sensitive-action register, and enforced anyway: `customerService.saveCustomer()`
  opens with `assertCapability(currentId ? "edit_customer" : "add_customer")`, and
  the database gates the same acts (`public.can('add_customer')` in migration
  0028, which is why they do not appear in the SQL gap list). The register exists
  to tie a *sensitive act* to a named guard so a test can prove the guard really
  asserts it; these three are asserted inline instead. Enforced on all three
  layers, documented on two.
- **`view_cost`** — the one genuine limitation in this matrix. It is enforced in
  the UI (the field is not rendered) and in the service (`assertCanViewCost`), but
  in live mode `cost_price` is a column on a table the reader may already select
  from, and Postgres row-level security has no column-level equivalent. Hiding it
  server-side would need a cost-free view plus a client that reads it — an
  architecture change, not a hardening one. Anyone able to read products over the
  API can read what the shop paid; nobody without `view_cost` can see it in the
  app, and `change_cost` — the act that matters — is registered, guarded and
  audited.
- **The 18 with no literal `public.can('<capability>')`** — each has its database
  story in the column above, and each was spot-checked: `sell` and the money acts
  run through `public.pos_complete_sale` / `pos_settle_refund`, which reprice and
  re-check server-side and leave no direct-write policy on `sales`; `import_data`
  and `export_data` are read/write paths over tables whose RLS already decides;
  `run_health_check` reads a snapshot the caller was allowed to open.
- **No capability is held by zero roles**, and none is missing from the catalogue,
  so the Permission Builder can grant all 45 and every one of them is reachable by
  somebody by default.
