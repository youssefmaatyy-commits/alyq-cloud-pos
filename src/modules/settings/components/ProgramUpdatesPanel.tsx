import { useEffect, useState } from "react";
import { Button, Card } from "@/components/ui";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { APP_VERSION } from "@/lib/appVersion";
import { desktopApi, getDesktopContext } from "@/lib/desktop/bridge";
import { compareVersions, fetchLatestRelease, OFFICIAL_RELEASES_URL, type LatestRelease } from "@/modules/system/services/releaseCheck";

type CheckState = "idle" | "checking" | "available" | "current" | "error";

interface ChannelInfo {
  version: string;
  gitSha: string;
  releasedAt: string;
  releaseNotes: { en: string; ar: string };
  windowsUrl: string | null;
  windowsSha256: string | null;
  androidUrl: string | null;
}

/**
 * Try the same-origin version channel first (served with no-store from Vercel).
 * Falls back to the GitHub Releases API when offline from the web deployment
 * (e.g. Electron without network, or Vercel unreachable).
 */
async function fetchChannelInfo(): Promise<ChannelInfo | null> {
  // 1. Try same-origin /version.json (preferred — fast, no API rate limit)
  try {
    const r = await fetch("/version.json", { cache: "no-store", headers: { Accept: "application/json" } });
    if (r.ok) {
      const j = (await r.json()) as Record<string, unknown>;
      const c = (j.current ?? j) as Record<string, unknown>;
      const channels = c.channels as Record<string, Record<string, unknown>> | undefined;
      if (typeof c.version === "string") {
        return {
          version: c.version,
          gitSha: typeof c.gitSha === "string" ? c.gitSha : "",
          releasedAt: typeof c.releasedAt === "string" ? c.releasedAt : "",
          releaseNotes: (c.releaseNotes as { en: string; ar: string }) ?? { en: "", ar: "" },
          windowsUrl: (channels?.windows?.url as string) ?? null,
          windowsSha256: (channels?.windows?.sha256 as string) ?? null,
          androidUrl: (channels?.android?.url as string) ?? null,
        };
      }
    }
  } catch { /* fall through to GitHub */ }

  // 2. Fallback: GitHub Releases API
  try {
    const release = await fetchLatestRelease();
    return {
      version: release.version,
      gitSha: "",
      releasedAt: "",
      releaseNotes: { en: "", ar: "" },
      windowsUrl: release.url,
      windowsSha256: null,
      androidUrl: null,
    };
  } catch { return null; }
}

export function ProgramUpdatesPanel() {
  const { lang } = useI18n();
  const ar = lang === "ar";
  const [currentVersion, setCurrentVersion] = useState(APP_VERSION);
  const [latest, setLatest] = useState<LatestRelease | null>(null);
  const [channel, setChannel] = useState<ChannelInfo | null>(null);
  const [state, setState] = useState<CheckState>("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void getDesktopContext().then((context) => {
      if (active && context?.version) setCurrentVersion(context.version);
    }).catch(() => { /* Keep the bundled version for browser previews. */ });
    return () => { active = false; };
  }, []);

  const check = async () => {
    setState("checking");
    setError("");
    try {
      const info = await fetchChannelInfo();
      if (!info) throw new Error("No channel response");
      const comparison = compareVersions(info.version, currentVersion);
      if (comparison === null) throw new Error("Invalid release version");
      setChannel(info);
      setLatest({ version: info.version, url: info.windowsUrl ?? OFFICIAL_RELEASES_URL });
      setState(comparison > 0 ? "available" : "current");
    } catch {
      setChannel(null);
      setLatest(null);
      setState("error");
      setError(ar
        ? "تعذر الاتصال بإصدارات GitHub. تحقق من الاتصال وحاول مرة أخرى."
        : "Could not reach GitHub Releases. Check your connection and try again.");
    }
  };

  const openRelease = async () => {
    // Prefer the direct installer URL when available; otherwise the releases page.
    const target = channel?.windowsUrl ?? latest?.url ?? OFFICIAL_RELEASES_URL;
    const api = desktopApi();
    if (api) await api.openExternal(target);
    else window.open(target, "_blank", "noopener,noreferrer");
  };

  return <Card className="mb-4" data-testid="program-updates-panel">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-black text-stone-900">{ar ? "تحديثات البرنامج" : "Program updates"}</h2>
        <p className="mt-1 text-xs text-stone-600">
          {ar ? "الإصدار الحالي: " : "Current version: "}<bdi dir="ltr" className="font-mono font-bold">{currentVersion}</bdi>
        </p>
        <p className="mt-2 max-w-3xl text-xs leading-relaxed text-stone-600">
          {ar
            ? "يتم فحص GitHub Releases الرسمي فقط. بسبب عدم توفر شهادة Authenticode، التنزيل والتثبيت يدويان وبموافقتك؛ لا يوجد تثبيت صامت أو تلقائي، وقد يعرض Windows تحذير SmartScreen. لا تبدأ التحديث أثناء البيع أو الطباعة أو المزامنة."
            : "Checks only the official GitHub Releases feed. Without an Authenticode certificate, downloads and installation remain manual and require your approval; there is no silent or automatic installation, and Windows may show a SmartScreen warning. Do not update during a sale, print job, or sync."}
        </p>
        {state === "available" && (channel || latest) ? <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3" role="status" data-testid="program-update-available">
          <p className="text-sm font-bold text-amber-950">
            {ar ? "يتوفر إصدار أحدث: " : "A newer version is available: "}<bdi dir="ltr" className="font-mono">{channel?.version ?? latest!.version}</bdi>
          </p>
          {channel?.releaseNotes[ar ? "ar" : "en"] ? (
            <p className="mt-1 text-xs text-amber-900">{channel.releaseNotes[ar ? "ar" : "en"]}</p>
          ) : (
            <p className="mt-1 text-xs text-amber-900">
              {ar ? "نزّل ملف التثبيت من صفحة GitHub الرسمية ثم أغلق البرنامج بنفسك بعد حفظ العمل." : "Download the installer from the official GitHub page, then close the app yourself after saving work."}
            </p>
          )}
          {channel?.windowsSha256 ? (
            <p className="mt-2 break-all font-mono text-[10px] text-amber-900" dir="ltr">SHA-256: {channel.windowsSha256}</p>
          ) : null}
        </div> : null}
        {state === "current" ? <p className="mt-3 text-xs font-semibold text-emerald-800" role="status" data-testid="program-update-current">
          {ar ? "هذا الإصدار ليس أقدم من أحدث إصدار منشور." : "This installation is not older than the latest published release."}
        </p> : null}
        {state === "error" ? <p className="mt-3 text-xs font-semibold text-red-700" role="alert">{error}</p> : null}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={() => void check()} disabled={state === "checking"} data-testid="program-check-updates">
          {state === "checking" ? (ar ? "جارٍ البحث…" : "Checking…") : (ar ? "البحث عن تحديثات" : "Check for updates")}
        </Button>
        {state === "available" ? <Button size="sm" onClick={() => void openRelease()} data-testid="program-download-update">
          {ar ? "فتح التنزيل الرسمي" : "Open official download"}
        </Button> : null}
      </div>
    </div>
    <p className="mt-3 text-[10px] text-stone-500">
      {ar ? "المصدر الرسمي: " : "Official source: "}
      <a className="underline underline-offset-2" href={latest?.url ?? channel?.windowsUrl ?? OFFICIAL_RELEASES_URL} target="_blank" rel="noreferrer">
        github.com/youssefmaatyy-commits/alyq-cloud-pos/releases
      </a>
      {channel?.gitSha ? <span className="ms-2 font-mono">· {channel.gitSha.slice(0, 7)}</span> : null}
    </p>
  </Card>;
}
