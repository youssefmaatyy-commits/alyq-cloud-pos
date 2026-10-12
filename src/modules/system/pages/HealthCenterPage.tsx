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
import { RELEASE, releaseDiagnostics } from "@/lib/release";
import { buildOperationalHealth, type OperationalHealthState } from "@/modules/operations/services/health";
import { probeSystemBackend, type BackendHealthProbe } from "../services/healthService";
import { safeDiagnosticsJson } from "../services/diagnostics";
import { getDesktopConfig, getDesktopContext, listDesktopPrinters } from "@/lib/desktop/bridge";
import { useRegister } from "@/modules/registers";

const tone: Record<OperationalHealthState, "success" | "warning" | "danger" | "neutral"> = {
  healthy: "success", warning: "warning", unavailable: "danger", unknown: "neutral",
};

export function HealthCenterPage() {
  const { lang, date } = useI18n();
  const auth = useAuth();
  const branch = useBranch();
  const register = useRegister();
  const pos = usePos();
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
    release: "إصدار التطبيق", releaseVersion: "الإصدار", releaseCommit: "بصمة الالتزام",
    releaseBuilt: "تاريخ البناء", releaseMode: "وضع التشغيل", releaseDirty: "شجرة عمل غير نظيفة",
    releaseUnset: "غير محدد", releaseNote: "أربعة حقول فقط: الإصدار، والالتزام، ووقت البناء، والوضع — بلا أسرار أو مفاتيح أو عناوين.",
  } : {
    title: "System Health Center", subtitle: "A safe, factual answer to “Is ALYQ healthy?” without secrets or dangerous repair actions.",
    check: "Retry health checks", refresh: "Refresh session and branch", sync: "Open Sync Center", diagnostics: "Copy safe diagnostics",
    copied: "Copied", checked: "Last checked", app: "Application", backend: "Database / Backend", auth: "Authentication", realtime: "Realtime",
    queue: "Offline Queue", storage: "Local Storage", migration: "Migration Compatibility", branch: "Branch Context",
    healthy: "Healthy", warning: "Warning", unavailable: "Unavailable", unknown: "Unknown", imageStorage: "Product image storage",
    imageUnknown: "Unknown — no junk file was uploaded to test it.", expected: "Expected schema", noSecrets: "Diagnostics exclude auth tokens, cookies, passwords, PINs, secrets and raw payment payloads.",
    desktop: "Desktop application", register: "Register identity", hardware: "Printer / Drawer", webRuntime: "Web runtime — no native bridge", physicalUnknown: "Physical state is Unknown; driver visibility does not prove paper or drawer movement.",
    ready: "Ready", setupRequired: "Setup required",
    release: "Build & release identity", releaseVersion: "Version", releaseCommit: "Commit",
    releaseBuilt: "Built at", releaseMode: "Application mode", releaseDirty: "Unclean worktree",
    releaseUnset: "unset", releaseNote: "Four fields only — version, commit, build time and mode. No secrets, keys or project URLs.",
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

  // The four facts the Health screen reports about this bundle. Read once, from
  // the build-time identity — never from the network, never from a credential.
  const release = useMemo(() => releaseDiagnostics(RELEASE), []);

  const labels = {
    application: copy.app, backend: copy.backend, authentication: copy.auth, realtime: copy.realtime,
    offline_queue: copy.queue, storage: copy.storage, migration: copy.migration, branch: copy.branch,
  } as const;

  const diagnostics = () => ({
    generated_at: new Date().toISOString(),
    application: "ALYQ Cloud POS",
    // Which build this is: version, commit, build time, mode. Credential-free by
    // construction — see `releaseDiagnostics()`.
    release: releaseDiagnostics(),
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
          {desktop?.context ? <p dir="ltr" className="mt-2 break-all font-mono text-[11px] text-stone-500">{desktop.context.build}</p> : null}
        </Card>
        <Card><p className="text-[11px] font-bold uppercase text-stone-500">{copy.register}</p>
          <Badge className="mt-2" tone={register.state.kind === "desktop-ready" ? "success" : register.state.kind === "web" ? "neutral" : "warning"}>{register.state.kind === "desktop-ready" ? copy.ready : register.state.kind === "web" ? copy.webRuntime : copy.setupRequired}</Badge>
          {register.state.register ? <p className="mt-2 text-xs text-stone-600">{register.state.register.name} · {register.state.register.code}</p> : null}
        </Card>
        <Card><p className="text-[11px] font-bold uppercase text-stone-500">{copy.hardware}</p><Badge className="mt-2" tone="neutral">{copy.unknown}</Badge><p className="mt-2 text-xs text-stone-600">{copy.physicalUnknown}</p>{desktop?.printerConfigured ? <p className="mt-1 text-xs text-stone-500">{desktop.paperWidthMm}mm · driver {desktop.configuredPrinterVisible ? "visible" : "not visible"}</p> : null}</Card>
      </div>
      {/* `Card` takes `testId`, not `data-testid`: the prop is explicit there, so a
          `data-testid` attribute is dropped silently and a suite would look for a
          card that never existed. */}
      <Card className="mt-3" testId="health-release">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-[11px] font-bold uppercase text-stone-500">{copy.release}</p>
            <p className="mt-1 text-xs text-stone-500">{copy.releaseNote}</p>
          </div>
          <Badge tone={release.mode === "production" ? "success" : "neutral"}>
            {release.mode === "unset" ? copy.releaseUnset : release.mode}
          </Badge>
        </div>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-[11px] font-bold uppercase tracking-wide text-stone-500">{copy.releaseVersion}</dt>
            <dd dir="ltr" className="mt-1 font-mono text-sm font-bold text-stone-900" data-testid="release-version">{release.version}</dd>
          </div>
          <div>
            <dt className="text-[11px] font-bold uppercase tracking-wide text-stone-500">{copy.releaseCommit}</dt>
            <dd dir="ltr" className="mt-1 break-all font-mono text-xs text-stone-800" data-testid="release-sha">{release.sha}</dd>
          </div>
          <div>
            <dt className="text-[11px] font-bold uppercase tracking-wide text-stone-500">{copy.releaseBuilt}</dt>
            <dd dir="ltr" className="mt-1 font-mono text-xs text-stone-800" data-testid="release-built-at">
              {release.built_at ?? copy.unknown}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] font-bold uppercase tracking-wide text-stone-500">{copy.releaseMode}</dt>
            <dd dir="ltr" className="mt-1 font-mono text-xs text-stone-800" data-testid="release-mode">
              {release.mode === "unset" ? copy.releaseUnset : release.mode}
              {release.dirty ? ` · ${copy.releaseDirty}` : ""}
            </dd>
          </div>
        </dl>
      </Card>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Card><p className="text-[11px] font-bold uppercase text-stone-500">{copy.imageStorage}</p><Badge className="mt-2" tone="neutral">{copy.unknown}</Badge><p className="mt-2 text-xs text-stone-600">{copy.imageUnknown}</p></Card>
        <Card><p className="text-[11px] font-bold uppercase text-stone-500">{copy.expected}</p><p dir="ltr" className="mt-2 font-mono text-xs font-bold text-stone-800">{SHIPPED_MIGRATION_COUNT} · {SHIPPED_LATEST_MIGRATION}</p><p className="mt-2 text-xs text-stone-500">{backend ? `${copy.checked}: ${date(backend.checkedAt)}` : copy.unknown}</p></Card>
      </div>
      <Card className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-black text-stone-900">Diagnostics</h2><p className="mt-1 text-xs text-stone-500">{copy.noSecrets}</p></div><Button variant="secondary" onClick={() => void copyDiagnostics()}>{copied ? copy.copied : copy.diagnostics}</Button></div>
      </Card>
    </div>
  );
}
