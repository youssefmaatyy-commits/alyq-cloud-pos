import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

import { resolveAppMode, type ResolvedAppMode } from "./src/lib/appMode";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ── release identity ──────────────────────────────────────────────────────
 * Every build carries the version it came from, the commit it was built at and
 * the moment it was built. In CI the SHA comes from the environment
 * (`VITE_BUILD_SHA`, so a tag or a protected branch can pin it); locally it is
 * read from Git, and a worktree with uncommitted changes is marked `-dirty`
 * rather than pretending to be a release. Nothing here is secret.
 */
function gitIdentity(root: string): { sha: string; dirty: boolean } {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length > 0;
    return { sha, dirty };
  } catch {
    return { sha: "unknown", dirty: false };
  }
}

interface ReleaseIdentity {
  version: string;
  sha: string;
  builtAt: string;
  dirty: boolean;
}

function releaseIdentity(root: string, outDir: string): ReleaseIdentity {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: string };
  void outDir;
  const fromGit = gitIdentity(root);
  const sha = (process.env.VITE_BUILD_SHA ?? "").trim() || fromGit.sha;
  const dirty = fromGit.dirty || /-dirty$/i.test(sha);
  return {
    version: (process.env.VITE_APP_VERSION ?? "").trim() || pkg.version || "0.0.0",
    sha: dirty && !/-dirty$/i.test(sha) ? `${sha}-dirty` : sha,
    builtAt: (process.env.VITE_BUILD_TIME ?? "").trim() || new Date().toISOString(),
    dirty,
  };
}

/**
 * Fail closed at build time.
 *
 * A `VITE_APP_MODE=production` build whose Supabase configuration is missing,
 * incomplete, malformed or dangerous must not produce an artifact at all — the
 * runtime screen in `src/components/ConfigurationErrorScreen.tsx` is the second
 * line of defence, for the case where environment variables are changed after
 * the build (they cannot be: Vite inlines them, which is exactly why the build
 * step is the right place to stop). The validation policy is imported from
 * `src/lib/appMode.ts`; this file does not re-implement it.
 */
function productionConfigurationGuard(resolved: ResolvedAppMode): Plugin {
  return {
    name: "alyq-production-configuration-guard",
    apply: "build",
    configResolved() {
      if (resolved.mode !== "production") return;
      const fatal = resolved.issues.filter((issue) => issue.severity === "fatal");
      if (fatal.length === 0) {
        const warnings = resolved.issues.filter((issue) => issue.severity === "warning");
        for (const issue of warnings) {
          console.warn(`\n[alyq] production configuration warning · ${issue.code} · ${issue.field}\n  ${issue.message}\n`);
        }
        return;
      }
      const detail = fatal.map((issue) => `  ✗ ${issue.code} · ${issue.field}\n    ${issue.message}`).join("\n");
      throw new Error(
        `\n[alyq] refusing to build a production bundle with an unusable Supabase configuration.\n` +
          `${detail}\n\n` +
          `  Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see docs/production/production-environment.md),\n` +
          `  or build the evaluation bundle with VITE_APP_MODE=demo.\n`,
      );
    },
  };
}

/** Writes `dist/release.json` — the document the release probe reads back. */
function releaseManifestPlugin(identity: ReleaseIdentity, resolved: ResolvedAppMode, explicitMode: string): Plugin {
  return {
    name: "alyq-release-manifest",
    apply: "build",
    writeBundle(options) {
      const outDir = options.dir ?? path.join(__dirname, "dist");
      const manifest = {
        version: identity.version,
        sha: identity.sha,
        built_at: identity.builtAt,
        dirty: identity.dirty,
        mode: resolved.mode,
        mode_source: resolved.source,
        mode_requested: explicitMode || null,
        currency: (process.env.VITE_CURRENCY ?? "EGP").trim() || "EGP",
        schema_migration: readShippedMigration(),
        configuration_issues: resolved.issues.map((issue) => issue.code),
        node: process.version,
      };
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    },
  };
}

/** Highest shipped migration name — release metadata, no database access. */
function readShippedMigration(): string | null {
  const source = fs.readFileSync(path.join(__dirname, "src/modules/operations/types.ts"), "utf8");
  return source.match(/SHIPPED_LATEST_MIGRATION\s*=\s*["']([^"']+)["']/)?.[1] ?? null;
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "");

  // VAPID's public application-server key is the one deliberately browser-safe
  // Web Push value. No WEB_PUSH_* private value is exposed or VITE-prefixed.
  const webPushPublicKey = (env.WEB_PUSH_VAPID_PUBLIC_KEY ?? "").trim();

  const requestedMode = (env.VITE_APP_MODE ?? "").trim();
  const resolvedMode = resolveAppMode({
    appMode: requestedMode,
    supabaseUrl: env.VITE_SUPABASE_URL,
    supabaseAnonKey: env.VITE_SUPABASE_ANON_KEY,
    demoSeed: env.VITE_DEMO_SEED,
  });
  const identity = releaseIdentity(__dirname, "dist");

  return {
    plugins: [
      react(),
      tailwindcss(),
      viteSingleFile(),
      productionConfigurationGuard(resolvedMode),
      releaseManifestPlugin(identity, resolvedMode, requestedMode),
    ],
    define: {
      "import.meta.env.WEB_PUSH_VAPID_PUBLIC_KEY": JSON.stringify(webPushPublicKey),
      // The resolved mode is stamped into the artifact so a demonstration build
      // is visibly a demonstration build even when it is opened offline.
      "import.meta.env.VITE_APP_MODE": JSON.stringify(requestedMode || resolvedMode.mode),
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(identity.version),
      "import.meta.env.VITE_BUILD_SHA": JSON.stringify(identity.sha),
      "import.meta.env.VITE_BUILD_TIME": JSON.stringify(identity.builtAt),
      "import.meta.env.VITE_BUILD_DIRTY": JSON.stringify(String(identity.dirty)),
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
      // `release.json` is generated in `writeBundle`; it must never be inlined
      // into index.html.
      sourcemap: false,
    },
  };
});
