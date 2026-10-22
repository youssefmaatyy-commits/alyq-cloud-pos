# ALYQ POS Mobile architecture

Status: Full ALYQ Cloud POS Android/iOS Application + Retained Mobile Management Quick View  
Targets: Android (`eg.alyq.management`, v2.0.0 / `versionCode 2`) and iOS

## Decision

ALYQ POS Mobile uses **Capacitor 8 around the shared React/TypeScript/Vite application**. When launched inside the native Capacitor container (`Capacitor.isNativePlatform()`), the root entry (`#/`) automatically routes into the full **`#/dashboard` (`AuthenticatedApp`)** workspace rather than the public customer storefront (`#/store`), while preserving `#/mobile` as a fast management quick-view shell.

This unified architecture provides every Web/Desktop ALYQ POS capability on mobile touch screens without duplicating business logic, repositories, or permission models:
- **Full POS Register & Cashier (`#/dashboard/pos`):** Touch-optimized product browse & search, sticky mobile cart drawer (`MobileCartSheet`), split/cash/InstaPay checkout, camera barcode scanning (`CameraBarcodeScannerModal`), HID keyboard-wedge barcode scanning (`useBarcodeScanner`), and Android native receipt printing (`window.ALYQAndroidPrint`).
- **Offline-First POS & Outbox Sync (`#/dashboard/sync`):** Durable IndexedDB catalog caching, offline cash sale completion, `@capacitor/network` connectivity transitions, idempotent `client_ref` replay, and stock-conflict protection.
- **Complete Back-Office & Store Operations:** Products, Variants & Barcodes, Categories, Inventory & Exact Shelves, Physical Stocktake, Stock Movements, Sales & Invoices, Returns & Refunds, Customers, Shifts, Expenses & End-of-Day (EOD), Online Orders & Stock Holds, Storefront & Marketing, Reports & Advanced Analytics, Manager Approvals, Notification Center, System Health, and Role/User/System Settings.
- **Touch Navigation (`MobilePosBottomNav`):** A fixed 5-tab mobile bottom bar (`Home`, `POS`, `Orders`, `Stock`, `Modules`) with a categorized one-tap bottom sheet (`mobile-pos-modules-sheet`) and bidirectional switching with `#/mobile`.

Financial tiles call the existing report aggregate RPC. Orders use the existing workflow/repository. Inventory receives active-branch shelves from the existing inventory repository. Invoice search calls `transaction_center_search` with server paging. Decisions and transitions use existing authoritative services.

Management writes require a live connection and are never blindly queued. Read failures produce unavailable states.

## Native trust boundary

Only reviewed Capacitor plugins are installed: App, Browser, Device, Network, Preferences and Push Notifications. No filesystem, shell, command execution, arbitrary native bridge, remote privileged page, or generic URL opener is exposed.

Incoming links are parsed against four fixed route shapes, bounded identifiers and permission preflight. The destination then performs a branch-scoped RLS/RPC read; a link is navigation intent, never authorization.

`mobile_installations` is separate from desktop `registers`. Its authenticated table policies deny every direct operation. Narrow RPCs let a user register/deactivate only their own installation. Raw provider tokens are never returned and are selectable only by trusted service-role delivery infrastructure.

## Push privacy and delivery

Push payloads contain a safe type and entity/reference ID only. Customer phone, address, payment detail, approval payload, PIN and credentials must not be sent. Realtime, polling/refresh and push converge on the existing stable `kind:entity` notification identity, preventing duplicate UI entries.

No APNs private key, FCM server credential or service-role key belongs in the client. Provider delivery requires production infrastructure documented in `mobile-build.md`.

## Session storage

ALYQ reuses Supabase authentication; passwords are never stored by ALYQ. Capacitor keeps WebView storage in the operating system application sandbox. A production security review may adopt an audited Keychain/Keystore session adapter, but it must preserve the existing Supabase refresh/revocation behavior and may not introduce a second account system.

Logout first asks the backend to deactivate the current installation and clear push routing, then ends the local auth session. If the network is unavailable, local logout still succeeds; server-side auth/session revocation and the platform/provider token lifecycle remain the ultimate controls.
