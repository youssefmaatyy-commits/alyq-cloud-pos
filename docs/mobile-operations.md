# ALYQ POS Mobile operations

## Sign-in and branch context

Use an existing ALYQ staff account. The app shows only memberships returned by `get_my_branches`; switching calls the authoritative audited branch RPC, refreshes identity/permissions and remounts branch-sensitive providers. Never use a link or copied branch ID as evidence of access.

Launching the **ALYQ POS** Android app (`eg.alyq.management`, `v2.0.0`) opens the full POS system (`#/dashboard`), with a 5-tab mobile bottom navigation bar and **All POS Modules** drawer (`24` modules), plus 1-tap switching to the lightweight **Mobile Management** view (`#/mobile`).

## Full POS & Cashier workflows on Android (`#/dashboard/*`)

- **POS Register (`#/dashboard/pos`):** full touch-first cashier with product/variant search, USB/Bluetooth HID scanner support, **Scan Barcode with Camera** modal (`BarcodeDetector` + Code 128 / EAN-13 / UPC-A 1D scanline decoder), sticky mobile cart summary bar, and full-screen Cart & Checkout Drawer.
- **Offline POS & Sync (`#/dashboard/sync`):** offline cash sales deduct from the cached catalog (`alyq.pos.offline_catalog.v1`), persist in the offline outbox (`alyq.pos.offline_outbox.v1`), and replay idempotently via `client_ref` when connectivity returns (`@capacitor/network` + browser online listeners). Stock shortages (`VARIANT_STOCK_INSUFFICIENT`) are preserved as explicit conflicts in the Sync Center without silent drops.
- **Android Receipt Printing:** completed sales and return receipts use the native `window.ALYQAndroidPrint` `PrintManager` bridge (`MainActivity.java`) to open the Android system print spooler (Save as PDF, Wi-Fi/IPP Mopria printers, or installed vendor Print Service plugins). Direct Bluetooth Classic (`SPP`) / BLE raw ESC/POS byte streaming requires an optional native plugin.
- **All POS Modules (`24` services):** Sales, Products, Barcodes, Inventory & Exact Variant Shelves, Stock Movements, Stock Counts, Transfers, Purchase Orders, Suppliers, Online Orders, Shipping, Returns, Customers, Shifts, Expenses, Reports, Approvals, Sync, Audit Log, Users/Roles, Diagnostics, and Settings.

## Quick Mobile Management workflows (`#/mobile/*`)

- **Home:** report-aggregate financial KPIs, order queue, exact branch stock alerts and approval count.
- **Orders:** bounded server queue and existing legal transitions. Cancellation/payment rejection requires a reason.
- **Inventory:** search product, SKU, barcode, color, flexible size or category; each exact variant displays its active-branch shelf.
- **Invoices:** server-side paged transaction search and stored invoice/payment/return/refund evidence.
- **Approvals:** operation-bound existing requests. Approval/rejection retains expiry, branch, fingerprint/correlation, single-use and audit enforcement.
- **Notifications:** stable operational identities deduplicate realtime, refresh and push intent.
- **Health:** existing backend/auth/realtime/schema/branch health plus mobile version, network and notification registration.
- **Full POS Bridge (`#/mobile/more`):** 1-tap links back to **POS Register (Cashier)** (`#/dashboard/pos`) and **Full ALYQ POS Workspace** (`#/dashboard`).

## Notification permission

The app asks only after the user chooses **Enable notifications**. Denial does not block the app and the prompt is not shown repeatedly by ALYQ. A safe lock-screen message names a reference such as “New order WEB-123”; it must not include customer phone/address or payment detail.

Logout deactivates the current mobile installation when reachable and unregisters local push. Administrators should also revoke the account/session and invalidate provider tokens for a lost device.

## Troubleshooting

- **Branch data missing:** confirm membership is active, switch branch again while online, then refresh.
- **Deep link denied:** sign in, select the authorized branch, and verify the role still holds the required permission. The app deliberately does not reveal whether a forbidden entity exists.
- **Action unavailable offline:** expected. Management mutations are not queued.
- **No push:** check OS permission and Mobile Health. “Registered” proves token registration, not provider delivery. Production FCM/APNs and entitlement setup must also be healthy.
- **Stale list:** pull/use Refresh. Refresh only reads authoritative state and does not replay actions.
- **Lost phone:** revoke sessions/account access and deactivate provider routing from trusted administration.

## Acceptance record

Record device model, OS version, app version/build, active branch, language/direction, push provider environment and test account role. Physical device, APNs/FCM delivery, store signing and store submission are separate acceptance activities and must not be inferred from software tests.
