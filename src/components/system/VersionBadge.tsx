import { useEffect, useState } from "react";
import { APP_VERSION } from "@/lib/appVersion";
import { getDesktopContext } from "@/lib/desktop/bridge";
import { getMobileRuntime } from "@/modules/mobile/services/mobileRuntime";

/**
 * Compact version badge shown in the app shell footer / diagnostics.
 * Shows the correct version for each runtime:
 * - Electron: packaged app.getVersion()
 * - Capacitor: VITE_APP_VERSION at native build time
 * - Browser: APP_VERSION (inlined from package.json at web build time)
 */
export function VersionBadge({ className }: { className?: string }) {
  const [version, setVersion] = useState(APP_VERSION);
  const [build, setBuild] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Prefer Electron context when available
    void getDesktopContext().then((ctx) => {
      if (cancelled || !ctx?.version) return;
      setVersion(ctx.version);
      setBuild(ctx.build.slice(0, 7));
    }).catch(() => {});
    // Fallback to mobile runtime for Capacitor shells
    void getMobileRuntime().then((rt) => {
      if (cancelled) return;
      if (rt.native && rt.appVersion) setVersion(rt.appVersion);
      if (rt.build && rt.build !== "development") setBuild(rt.build.slice(0, 7));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return (
    <span data-testid="version-badge" className={className ?? "font-mono text-[11px] text-stone-500"}>
      v{version}{build ? ` · ${build}` : ""}
    </span>
  );
}

export function VersionDiagnosticsLine() {
  const [details, setDetails] = useState<{ runtime: string; version: string; build: string; platform: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const desktop = await getDesktopContext().catch(() => null);
      if (desktop && !cancelled) {
        setDetails({ runtime: "electron", version: desktop.version, build: desktop.build, platform: `${desktop.platform}/${desktop.arch}` });
        return;
      }
      const mobile = await getMobileRuntime().catch(() => null);
      if (mobile && !cancelled) {
        setDetails({ runtime: mobile.native ? `capacitor-${mobile.platform}` : "web", version: mobile.appVersion, build: mobile.build, platform: mobile.platform });
        return;
      }
      if (!cancelled) setDetails({ runtime: "web", version: APP_VERSION, build: "development", platform: "web" });
    })();
    return () => { cancelled = true; };
  }, []);
  if (!details) return null;
  return (
    <span data-testid="version-diagnostics-line" dir="ltr" className="break-all font-mono text-[11px] text-stone-500">
      {details.runtime} · v{details.version} · {details.build.slice(0, 12)} · {details.platform}
    </span>
  );
}
