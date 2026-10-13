import path from "path";
import { assertBuildEnvironment, resolveApplicationConfig } from "./src/lib/config/application-mode.mjs";
import { releaseBuildPlugin, releaseIdentity } from "./scripts/lib/release-artifact.mjs";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  // Read server values for the scanner, but never define/spread them into JS.
  const env = { ...loadEnv(mode, __dirname, ""), ...process.env };
  const resolved = command === "build" ? assertBuildEnvironment(env) : resolveApplicationConfig(env);
  const config = resolved.ok ? resolved : { ok: true as const, mode: "production" as const, environment: "preview" as const, supabaseUrl: "", supabaseKey: "" };
  const identity = releaseIdentity(__dirname, config, env);
  // VAPID's public application-server key is the one deliberately browser-safe
  // Web Push value. No WEB_PUSH_* private value is exposed or VITE-prefixed.
  const webPushPublicKey = loadEnv(mode, __dirname, "WEB_PUSH_VAPID_PUBLIC_KEY")
    .WEB_PUSH_VAPID_PUBLIC_KEY?.trim() ?? "";
  return {
    plugins: [react(), tailwindcss(), viteSingleFile(), releaseBuildPlugin(__dirname, identity, env)],
    define: {
      __ALYQ_RELEASE__: JSON.stringify(identity),
      "import.meta.env.WEB_PUSH_VAPID_PUBLIC_KEY": JSON.stringify(webPushPublicKey),
    },
    server: {
      allowedHosts: true,
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
      },
    },
    build: {
      // Inline the ALYQ logo as a data URL so the singlefile plugin produces
      // a self-contained app shell. Manifest, icons and service worker remain
      // normal same-origin PWA assets copied from public/.
      assetsInlineLimit: 100_000,
    },
  };
});
