# ALYQ Mobile architecture

Status: Prompt 6 management application  
Targets: Android and iOS

## Decision

ALYQ Mobile uses **Capacitor 8 around a dedicated mobile route in the existing React/Vite application**. It is not another backend and it is not a cashier register. The `#/mobile` shell mounts the same authentication, branch, catalog, inventory, online-order, approval, permissions, realtime and health services used by web/Desktop.

This approach maximizes reuse while allowing native push notifications, app/deep-link lifecycle events, stable installation identity and store packaging. React Native or another rewrite would duplicate business repositories and permission logic. A PWA manifest is provided as a web convenience; Capacitor is the native release architecture.

## Scope and boundaries

The phone provides Home, Orders, Inventory/Product detail, Notifications, Invoices/Returns status, Approvals, branch switching and Health. It intentionally does not mount `PosProvider`, `RegisterProvider`, cash-sale offline outbox, printer or drawer adapters. A management phone is not a register.

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
