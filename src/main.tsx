import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { ConfigurationErrorScreen } from "@/components/ConfigurationErrorScreen";
import { FATAL_CONFIGURATION_ISSUES, STARTUP_BLOCKED, describeAppMode } from "@/lib/appMode";
import { releaseLine } from "@/lib/release";
import { registerALYQServiceWorker } from "@/modules/mobile/services/pwaBridge";

// One line, always available, never secret: which build is this, and which mode
// did it resolve to. Support can read it from the console or the system screen.
if (import.meta.env.DEV) console.log("=== MAIN.TSX: Starting app initialization ===");
console.log(`[alyq] ${releaseLine()} · ${describeAppMode()}`);

// PWA registration is transport-only and best effort. It never blocks React,
// session restoration, login, or ordinary browser use. It is skipped entirely
// when the build is blocked: a configuration-error screen needs no cache.
const rootElement = document.getElementById("root");

/**
 * Fail closed. A production build whose Supabase configuration is missing,
 * incomplete, malformed or dangerous renders the configuration-error screen —
 * and nothing else. No router, no providers, no demo repository, no service
 * worker. The alternative (today's behaviour before this module) was to fall
 * back to `localStorage`, which produces a till that looks live and is not.
 */
if (STARTUP_BLOCKED) {
  console.error(
    "[alyq] refusing to start: production configuration is invalid",
    FATAL_CONFIGURATION_ISSUES.map((issue) => `${issue.code}(${issue.field})`),
  );
  if (!rootElement) {
    document.body.textContent = "Configuration error — ALYQ Cloud POS cannot start. See the build log.";
  } else {
    createRoot(rootElement).render(
      <StrictMode>
        <ConfigurationErrorScreen />
      </StrictMode>,
    );
  }
} else {
  void registerALYQServiceWorker().catch(() => undefined);

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
}
