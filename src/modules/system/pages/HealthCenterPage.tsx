import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "@/components/layout/AppShell";
import { Badge, Button, Card } from "@/components/ui";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useAuth } from "@/lib/auth";
import { useBranch } from "@/lib/branch";
import { can } from "@/lib/permissions/enforce";
import { pathPermits } from "@/lib/permissions/routes";
import { useRealtimeStatus } from "@/lib/supabase/useRealtimeWatch";
import { usePos } from "@/modules/pos";
import { ensureOfflineSchema, type OfflineSchemaHealth } from "@/modules/pos/offline/schema";
import { SHIPPED_LATEST_MIGRATION, SHIPPED_MIGRATION_COUNT } from "@/modules/operations/types";
import { buildOperationalHealth, type OperationalHealthState } from "@/modules/operations/services/health";
import { probeSystemBackend, type BackendHealthProbe } from "../services/healthService";
import { safeDiagnosticsJson } from "../services/diagnostics";
import { getDesktopConfig, getDesktopContext, listDesktopPrinters } from "@/lib/desktop/bridge";
import { useRegister } from "@/modules/registers";
import { useWebNotifications } from "@/modules/notifications";
import { APP_VERSION } from "@/lib/appVersion";
import { VersionDiagnosticsLine } from "@/components/system/VersionBadge";
import { applyWebUpdate, checkForWebUpdate } from "@/lib/version/webUpdate";

const tone: Record<OperationalHealthState, "success" | "warning" | "danger" | "neutral"> = {
  healthy: "success", warning: "warning", unavailable: "danger", unknown: "neutral",
};

export function HealthCenterPage() {
  const { lang, date } = useI18n();
  const auth = useAuth();
  const branch = useBranch();
  const register = useRegister();
  const pos = usePos();
  const webNotifications = useWebNotifications();
  const { refreshSyncState } = pos;
  const activeBranchId = branch.current?.id ?? null;
  const branchError = branch.error;
  const refreshBranch = branch.refresh;
  const realtime = useRealtimeStatus();
  const [backend, setBackend] = useState<BackendHealthProbe | null>(null);
  const [storage, setStorage] = useState<OfflineSchemaHealth | null>(null);
  const [desktop, setDesktop] = useState<{
    context: Awaited<ReturnType<typeof getDesktopContext>>;
    printerConfigured: boolean;
    configuredPrinterVisible: boolean;
    paperWidthMm: number | null;
    drawerMode: string | null;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const checkingRef = useRef(false);
  const [copied, setCopied] = useState(false);
  const mayOpenSync = pathPermits("/sync", (permission) => can(permission));
  const ar = lang === "ar";
  const copy = ar ? {
    title: "مركز صحة النظام", subtitle: "إجابة آمنة وواضحة عن حالة أليق دون عرض أسرار أو تنفيذ إصلاحات خطرة.",
    check: "إعادة الفحص", refresh: "تحديث الجلسة والفرع", sync: "فتح مركز المزامنة", diagnostics: "نسخ التشخيصات الآمنة",
    copied: "تم النسخ", checked: "آخر فحص", app: "التطبيق", backend: "قاعدة البيانات / الخدمة", auth: "المصادقة", realtime: "التحديث الفوري",
    queue: "قائمة المزامنة", storage: "التخزين المحلي", migration: "توافق المخطط", branch: "سياق الفرع",
    healthy: "سليم", warning: "تحذير", unavailable: "غير متاح", unknown: "غير معروف", imageStorage: "تخزين صور المنتجات",
    imageUnknown: "غير معروف — لم يتم رفع ملف تجريبي.", expected: "المخطط المتوقع", noSecrets: "لا تشمل التشخيصات رموز الدخول أو ملفات الارتباط أو كلمات المرور أو أرقام PIN أو حمولات الدفع الخام.",
    desktop: "تطبيق سطح المكتب", register: "هوية السجل", hardware: "الطابعة / الدرج", webRuntime: "تشغيل ويب — لا يوجد جسر أصلي", physicalUnknown: "الحالة المادية غير معروفة؛ لا يثبت ظهور التعريف وجود ورق أو فتح الدرج.",
    ready: "جاهز", setupRequired: "يتطلب إعدادًا",
  } : {
    title: "System Health Center", subtitle: "A safe, factual answer to “Is ALYQ healthy?” without secrets or dangerous repair actions.",
    check: "Retry health checks", refresh: "Refresh session and branch", sync: "Open Sync Center", diagnostics: "Copy safe diagnostics",
    copied: "Copied", checked: "Last checked", app: "Application", backend: "Database / Backend", auth: "Authentication", realtime: "Realtime",
    queue: "Offline Queue", storage: "Local Storage", migration: "Migration Compatibility", branch: "Branch Context",
    healthy: "Healthy", warning: "Warning", unavailable: "Unavailable", unknown: "Unknown", imageStorage: "Product image storage",
    imageUnknown: "Unknown — no junk file was uploaded to test it.", expected: "Expected schema", noSecrets: "Diagnostics exclude auth tokens, cookies, passwords, PINs, secrets and raw payment payloads.",
    desktop: "Desktop application", register: "Register identity", hardware: "Printer / Drawer", webRuntime: "Web runtime — no native bridge", physicalUnknown: "Physical state is Unknown; driver visibility does not prove paper or drawer movement.",
    ready: "Ready", setupRequired: "Setup required",
  };

  const run = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    try {
      const [nextBackend, nextStorage, desktopContext, desktopConfig, printers] = await Promise.all([
        probeSystemBackend(), ensureOfflineSchema(), getDesktopContext(), getDesktopConfig(), listDesktopPrinters(),
      ]);
      setBackend(nextBackend);
      setStorage(nextStorage);
      setDesktop({
        context: desktopContext,
        printerConfigured: Boolean(desktopConfig?.hardware.printerName),
        configuredPrinterVisible: Boolean(desktopConfig?.hardware.printerName && printers.some((printer) => printer.name === desktopConfig.hardware.printerName)),
        paperWidthMm: desktopConfig?.hardware.paperWidthMm ?? null,
        drawerMode: desktopConfig?.hardware.drawerMode ?? null,
      });
      await refreshSyncState();
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  }, [refreshSyncState]);

  useEffect(() => { void run(); }, [run]); // one shot unless the provider itself is remounted

  const facts = useMemo(() => buildOperationalHealth({
    connectivity: pos.connectivityState,
    backend,
    authenticated: !backend || backend.authenticated === null ? null : backend.authenticated && auth.status === "authenticated" && Boolean(auth.session),
    realtime,
    queue: {
      pending: pos.syncPendingCount,
      failed: pos.syncErrorCount,
      deferred: pos.syncDeferredCount,
      conflicts: pos.syncConflictCount,
      lastSync: pos.lastSuccessfulSyncAt,
    },
    storage,
    branch: {
      id: activeBranchId,
      error: branchError,
      backendValid: backend ? backend.branchContextValid === true && backend.activeBranchId === activeBranchId : null,
    },
  }), [activeBranchId, auth.session, auth.status, backend, branchError, pos.connectivityState, pos.lastSuccessfulSyncAt, pos.syncConflictCount, pos.syncDeferredCount, pos.syncErrorCount, pos.syncPendingCount, realtime, storage]);

  const labels = {
    application: copy.app, backend: copy.backend, authentication: copy.auth, realtime: copy.realtime,
    offline_queue: copy.queue, storage: copy.storage, migration: copy.migration, branch: copy.branch,
  } as const;

  const diagnostics = () => ({
    generated_at: new Date().toISOString(),
    application: "ALYQ Cloud POS",
    expected_migration: SHIPPED_LATEST_MIGRATION,
    expected_migration_count: SHIPPED_MIGRATION_COUNT,
    connectivity: pos.connectivitySnapshot,
    backend: backend ? {
      reachable: backend.reachable,
      checked_at: backend.checkedAt,
      latency_ms: backend.latencyMs,
      authenticated: backend.authenticated,
      schema_status: backend.schemaStatus,
      server_migration: backend.serverMigration,
      server_migration_count: backend.serverMigrationCount,
      branch_context_valid: backend.branchContextValid,
      safe_error: backend.safeError,
    } : null,
    realtime,
    branch_id: activeBranchId,
    queue: { pending: pos.syncPendingCount, failed: pos.syncErrorCount, deferred: pos.syncDeferredCount, conflicts: pos.syncConflictCount, last_sync: pos.lastSuccessfulSyncAt },
    local_storage: storage,
    desktop: desktop?.context ? {
      runtime: desktop.context.runtime,
      platform: desktop.context.platform,
      arch: desktop.context.arch,
      version: desktop.context.version,
      build: desktop.context.build,
      packaged: desktop.context.packaged,
      installation_id: desktop.context.installationId,
      register_id: register.state.register?.id ?? null,
      register_state: register.state.kind,
      printer_configured: desktop.printerConfigured,
      configured_printer_visible: desktop.configuredPrinterVisible,
      paper_width_mm: desktop.paperWidthMm,
      drawer_mode: desktop.drawerMode,
      physical_hardware_state: "unknown",
    } : { runtime: "web" },
  });

  const copyDiagnostics = async () => {
    const text = safeDiagnosticsJson(diagnostics());
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const area = document.createElement("textarea"); area.value = text; area.style.position = "fixed"; area.style.opacity = "0";
      document.body.appendChild(area); area.select(); document.execCommand("copy"); area.remove();
    }
    setCopied(true); window.setTimeout(() => setCopied(false), 1500);
  };

  const refreshContext = async () => {
    await auth.refreshIdentity();
    await refreshBranch();
    await run();
  };

  return (
    <div data-testid="health-center">
      <PageHeader title={copy.title} subtitle={copy.subtitle} actions={(
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void run()} loading={checking}>{copy.check}</Button>
          <Button variant="secondary" onClick={() => void refreshContext()}>{copy.refresh}</Button>
          {mayOpenSync ? <Link to="/sync" className="inline-flex items-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800">{copy.sync}</Link> : null}
        </div>
      )} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {facts.map((fact) => <Card key={fact.key} data-testid={`health-${fact.key}`}>
          <p className="text-[11px] font-bold uppercase tracking-wide text-stone-500">{labels[fact.key]}</p>
          <Badge className="mt-2" tone={tone[fact.state]}>{copy[fact.state]}</Badge>
          {fact.detail ? <p dir={fact.key === "branch" || fact.key === "migration" ? "ltr" : undefined} className="mt-2 break-words text-xs text-stone-600">{fact.detail}</p> : null}
        </Card>)}
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Card><p className="text-[11px] font-bold uppercase text-stone-500">{copy.desktop}</p>
          <Badge className="mt-2" tone={desktop?.context ? "success" : "neutral"}>{desktop?.context ? `${desktop.context.version} · ${desktop.context.platform}/${desktop.context.arch}` : copy.webRuntime}</Badge>
          {desktop?.context ? (
            <p dir="ltr" className="mt-2 break-all font-mono text-[11px] text-stone-500">{desktop.context.build}</p>
          ) : webNotifications.runtime ? (
            <p dir="ltr" className="mt-2 font-mono text-xs font-semibold text-stone-700">
              v{webNotifications.runtime.appVersion} · {webNotifications.runtime.build} · {webNotifications.runtime.platform}
            </p>
          ) : null}
        </Card>
        <Card><p className="text-[11px] font-bold uppercase text-stone-500">{copy.register}</p>
          <Badge className="mt-2" tone={register.state.kind === "desktop-ready" ? "success" : register.state.kind === "web" ? "neutral" : "warning"}>{register.state.kind === "desktop-ready" ? copy.ready : register.state.kind === "web" ? copy.webRuntime : copy.setupRequired}</Badge>
          {register.state.register ? <p className="mt-2 text-xs text-stone-600">{register.state.register.name} · {register.state.register.code}</p> : null}
        </Card>
        <Card><p className="text-[11px] font-bold uppercase text-stone-500">{copy.hardware}</p><Badge className="mt-2" tone="neutral">{copy.unknown}</Badge><p className="mt-2 text-xs text-stone-600">{copy.physicalUnknown}</p>{desktop?.printerConfigured ? <p className="mt-1 text-xs text-stone-500">{desktop.paperWidthMm}mm · driver {desktop.configuredPrinterVisible ? "visible" : "not visible"}</p> : null}</Card>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Card><p className="text-[11px] font-bold uppercase text-stone-500">{copy.imageStorage}</p><Badge className="mt-2" tone="neutral">{copy.unknown}</Badge><p className="mt-2 text-xs text-stone-600">{copy.imageUnknown}</p></Card>
        <Card><p className="text-[11px] font-bold uppercase text-stone-500">{copy.expected}</p><p dir="ltr" className="mt-2 font-mono text-xs font-bold text-stone-800">{SHIPPED_MIGRATION_COUNT} · {SHIPPED_LATEST_MIGRATION}</p><p className="mt-2 text-xs text-stone-500">{backend ? `${copy.checked}: ${date(backend.checkedAt)}` : copy.unknown}</p></Card>
        <Card>
          <div data-testid="health-notifications">
            <p className="text-[11px] font-bold uppercase text-stone-500">{ar ? "الإشعارات والتنبيهات" : "Notifications"}</p>
            <Badge className="mt-2" tone={webNotifications.pushState === "registered" ? "success" : webNotifications.pushState === "error" || webNotifications.pushState === "denied" ? "warning" : "neutral"}>
              {webNotifications.pushState}
            </Badge>
            <p className="mt-2 text-xs text-stone-600">
              <Link to="/dashboard/notifications" className="font-semibold text-stone-800 underline hover:text-stone-950">
                {ar ? `فتح مركز الإشعارات (${webNotifications.notificationUnreadCount} غير مقروء)` : `Open Notification Center (${webNotifications.notificationUnreadCount} unread)`}
              </Link>
            </p>
          </div>
        </Card>
      </div>
      <Card className="mt-4">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-black text-stone-900">Diagnostics</h2><p className="mt-1 text-xs text-stone-500">{copy.noSecrets}</p></div><Button variant="secondary" onClick={() => void copyDiagnostics()}>{copied ? copy.copied : copy.diagnostics}</Button></div>
          <div className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2" data-testid="version-diagnostics">
            <p className="text-[11px] font-bold uppercase tracking-wide text-stone-500">{ar ? "معلومات الإصدار" : "Version information"}</p>
            <p className="mt-1 font-mono text-xs font-semibold text-stone-700">v{APP_VERSION} · {SHIPPED_LATEST_MIGRATION} (#{SHIPPED_MIGRATION_COUNT})</p>
            <VersionDiagnosticsLine />
            <WebUpdateCheckCard lang={lang} />
          </div>
        </div>
      </Card>
    </div>
  );
}

function WebUpdateCheckCard({ lang }: { lang: string }) {
  const ar = lang === "ar";
  const [state, setState] = useState<"idle" | "checking" | "available" | "current" | "error" | "offline">("idle");
  const [latest, setLatest] = useState<string | null>(null);
  const check = async () => {
    if (!navigator.onLine) { setState("offline"); return; }
    setState("checking");
    try {
      const info = await checkForWebUpdate();
      if (info) { setLatest(info.latestVersion); setState("available"); }
      else { setState("current"); }
    } catch { setState("error"); }
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="health-update-check">
      <Button variant="secondary" size="sm" onClick={() => void check()} disabled={state === "checking"} data-testid="health-check-update"> 
        {state === "checking" ? (ar ? "جارٍ الفحص…" : "Checking…") : ar ? "التحقق من التحديثات" : "Check for updates"}
      </Button>
      {state === "available" && latest ? (
        <span className="text-xs font-bold text-amber-900" data-testid="health-update-available">
          {ar ? `يتوفر ${latest}` : `Update available: ${latest}`} · <button type="button" className="underline" onClick={() => applyWebUpdate()} data-testid="health-update-apply">{ar ? "تحديث الآن" : "Update now"}</button>
        </span>
      ) : null}
      {state === "current" ? <span className="text-xs font-semibold text-emerald-700" data-testid="health-update-current">{ar ? "أنت على أحدث إصدار." : "Up to date."}</span> : null}
      {state === "error" ? <span className="text-xs font-semibold text-red-700">{ar ? "تعذر الاتصال." : "Could not check."}</span> : null}
      {state === "offline" ? <span className="text-xs font-semibold text-stone-600">{ar ? "غير متصل." : "Offline."}</span> : null}
    </div>
  );
}

