import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // VAPID's public application-server key is the one deliberately browser-safe
  // Web Push value. No WEB_PUSH_* private value is exposed or VITE-prefixed.
  const webPushPublicKey = loadEnv(mode, __dirname, "WEB_PUSH_VAPID_PUBLIC_KEY")
    .WEB_PUSH_VAPID_PUBLIC_KEY?.trim() ?? "";
  return {
    plugins: [react(), tailwindcss(), viteSingleFile()],
    define: {
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
