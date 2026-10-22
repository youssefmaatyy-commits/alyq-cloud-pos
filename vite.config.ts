import fs from "fs";
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

  const stagingPreviewPath = path.join(__dirname, ".staging-preview-env.json");
  const stagingPreview =
    process.env.VERCEL_ENV === "preview" && fs.existsSync(stagingPreviewPath)
      ? (JSON.parse(fs.readFileSync(stagingPreviewPath, "utf8")) as { url: string; anonKey: string })
      : null;

  return {
    plugins: [react(), tailwindcss(), viteSingleFile()],
    define: {
      "import.meta.env.WEB_PUSH_VAPID_PUBLIC_KEY": JSON.stringify(webPushPublicKey),
      ...(stagingPreview
        ? {
            "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(stagingPreview.url),
            "import.meta.env.VITE_SUPABASE_ANON_KEY": JSON.stringify(stagingPreview.anonKey),
          }
        : {}),
    },
    server: {
      allowedHosts: true,
    },
    preview: {
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
