import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import {
  applyWebUpdate,
  checkForWebUpdate,
  dismissUpdate,
  UPDATE_CHECK_EVENT,
  type UpdateInfo,
} from "@/lib/version/webUpdate";

/**
 * Sticky update banner — appears when a newer /version.json is detected.
 * - Never blocks login or offline queue; user can "Update later" (dismiss this session).
 * - "Update now" reloads the page to fetch the fresh deployment; offline cart/queue survive
 *   because they live in localStorage/IndexedDB, not in-memory.
 * - Also usable as a manual check from Settings/System pages.
 */
export function UpdateBanner() {
  const { lang } = useI18n();
  const ar = lang === "ar";
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<UpdateInfo>).detail;
      if (detail?.latestVersion) { setInfo(detail); setVisible(true); }
    };
    // Catch if an update was already detected before mount
    const onDismissed = () => setVisible(false);
    window.addEventListener(UPDATE_CHECK_EVENT, handler as EventListener);
    window.addEventListener("alyq:update-dismissed", onDismissed);
    return () => {
      window.removeEventListener(UPDATE_CHECK_EVENT, handler as EventListener);
      window.removeEventListener("alyq:update-dismissed", onDismissed);
    };
  }, []);

  if (!info || !visible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="web-update-banner"
      className="sticky top-0 z-40 border-b border-amber-300 bg-amber-50 px-4 py-3"
    >
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-amber-950">
            {ar ? "يتوفر تحديث جديد" : "A new update is available"}{" "}
            <bdi dir="ltr" className="font-mono">v{info.latestVersion}</bdi>
            <span className="mx-2 font-normal text-amber-800">
              ({ar ? "الإصدار الحالي" : "you have"} v{info.currentVersion})
            </span>
          </p>
          {info.releaseNotes[ar ? "ar" : "en"] ? (
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-amber-900">
              {info.releaseNotes[ar ? "ar" : "en"]}
            </p>
          ) : null}
          <p className="mt-1 text-[11px] text-amber-800">
            {ar
              ? "لن تُفقد سلة التسوق أو العمليات المحلية عند التحديث."
              : "Your cart and offline operations will be preserved."}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => applyWebUpdate()}
            data-testid="web-update-apply"
            className="rounded-lg bg-amber-900 px-4 py-2 text-sm font-bold text-white hover:bg-amber-950"
          >
            {ar ? "تحديث الآن" : "Update now"}
          </button>
          <button
            type="button"
            onClick={() => { dismissUpdate(info.latestVersion); setVisible(false); }}
            data-testid="web-update-dismiss"
            className="rounded-lg border border-amber-300 bg-white px-4 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-100"
          >
            {ar ? "لاحقًا" : "Later"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Hook for pages that want to trigger a manual update check (e.g. Settings → System).
 */
export function useManualUpdateCheck() {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<"idle" | "available" | "current" | "error" | "offline">("idle");
  const [latest, setLatest] = useState<string | null>(null);

  const check = async () => {
    if (!navigator.onLine) { setResult("offline"); return; }
    setChecking(true);
    try {
      const info = await checkForWebUpdate();
      if (info) { setLatest(info.latestVersion); setResult("available"); }
      else { setResult("current"); }
    } catch { setResult("error"); }
    finally { setChecking(false); }
  };

  return { checking, result, latest, check };
}
