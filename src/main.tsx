import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { registerALYQServiceWorker } from "@/modules/mobile/services/pwaBridge";
import { normalizeNativeEntryUrl } from "@/modules/mobile/services/mobileRuntime";

// When launched inside the installed Capacitor Android/iOS app at `#/`, open
// the full ALYQ POS application (`#/dashboard`) rather than the public shop.
normalizeNativeEntryUrl();

// PWA registration is transport-only and best effort. It never blocks React,
// session restoration, login, or ordinary browser use.
void registerALYQServiceWorker().catch(() => undefined);

// Web update polling — starts shortly after boot, checks /version.json every 5 min.
// Never blocks rendering and survives offline (failed fetches are retried).
import { startWebUpdatePolling } from "@/lib/version/webUpdate";
void (typeof window !== "undefined" && window.requestIdleCallback
  ? new Promise<void>((r) => window.requestIdleCallback(() => r()))
  : new Promise<void>((r) => setTimeout(r, 2000))).then(() => startWebUpdatePolling());

if (import.meta.env.DEV) console.log("=== MAIN.TSX: Starting app initialization ===");

const rootElement = document.getElementById("root");
if (import.meta.env.DEV) console.log("=== MAIN.TSX: Root element:", rootElement);

if (!rootElement) {
  console.error("=== MAIN.TSX: Root element not found! ===");
  document.body.innerHTML = '<div style="padding:20px;color:red;font-family:monospace;">ERROR: Root element not found</div>';
} else {
  if (import.meta.env.DEV) console.log("=== MAIN.TSX: Creating React root ===");
  const root = createRoot(rootElement);
  if (import.meta.env.DEV) console.log("=== MAIN.TSX: Rendering App component ===");
  root.render(
    <StrictMode>
      <App />
    </StrictMode>
  );
  if (import.meta.env.DEV) console.log("=== MAIN.TSX: Render call completed ===");
}
