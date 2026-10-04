import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "@/components/layout/AppShell";
import { Badge, Button, Card, EmptyState } from "@/components/ui";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useBranch } from "@/lib/branch";
import { useInventory } from "@/modules/inventory/hooks/InventoryProvider";
import { can } from "@/lib/permissions/enforce";
import { pathPermits } from "@/lib/permissions/routes";
import { usePos } from "../hooks/PosProvider";
import { clearDisposableCatalogCache } from "../offline/schema";
import { listSafeSyncOperations } from "../offline/outbox";
import type { OfflineSyncStatus, SafeSyncOperation } from "../offline/types";

const statusTone: Record<OfflineSyncStatus, "neutral" | "info" | "success" | "warning" | "danger"> = {
  pending: "warning", syncing: "info", synced: "success", failed: "danger", deferred: "warning", conflict: "danger",
};

export function SyncCenterPage() {
  const { lang, date, money } = useI18n();
  const pos = usePos();
  const { refreshSyncState } = pos;
  const branch = useBranch();
  const activeBranchId = branch.current?.id ?? null;
  const { user } = useInventory();
  const mayRetrySales = can("pos.sell");
  const mayRefreshCatalog = can("products.view");
  const mayOpenHealth = pathPermits("/system-health", (permission) => can(permission));
  const [operations, setOperations] = useState<SafeSyncOperation[]>([]);
  const [busyRef, setBusyRef] = useState<string | null>(null);
  const [refreshingCache, setRefreshingCache] = useState(false);
  const ar = lang === "ar";
  const copy = ar ? {
    title: "مركز العمل دون اتصال والمزامنة", health: "صحة النظام",
    subtitle: "حالة الاتصال والعمليات المحلية الآمنة — دون تعديل الحمولات أو تحويلها إلى فرع آخر.",
    connectivity: "الاتصال", currentBranch: "الفرع الحالي", operator: "المستخدم / السياق", lastSync: "آخر مزامنة ناجحة",
    pending: "قيد الانتظار", failed: "فشل", deferred: "مؤجل", conflicts: "تعارض", history: "العمليات وسجل المزامنة",
    retryAll: "إعادة محاولة المؤهل", refreshCache: "تحديث الكتالوج الآمن", cached: "بيانات الكتالوج مخزنة مؤقتاً وقد لا تمثل المخزون الحالي.",
    created: "أُنشئت", attempted: "آخر محاولة", completed: "اكتملت", retries: "المحاولات", originalBranch: "الفرع الأصلي", originalUser: "المستخدم الأصلي", retry: "إعادة المحاولة",
    noRows: "لا توجد عمليات محلية", noRowsHint: "ستظهر هنا مبيعات النقد المدعومة عند إنشائها دون اتصال.",
    sale: "بيع نقدي", lines: "الأصناف", synced: "تمت المزامنة", syncing: "جارٍ المزامنة", online: "متصل", offline: "غير متصل", degraded: "متدهور", syncError: "خطأ مزامنة", conflict: "تعارض", now: "لم تتم بعد", register: "نقطة بيع الويب",
    backendReachable: "الخدمة متاحة", backendUnavailable: "الخدمة غير متاحة", backendUnknown: "حالة الخدمة غير معروفة",
  } : {
    title: "Offline & Sync Center", health: "System health",
    subtitle: "Connectivity and durable local operations—without payload editing or cross-branch redirection.",
    connectivity: "Connectivity", currentBranch: "Current branch", operator: "User / context", lastSync: "Last successful sync",
    pending: "Pending", failed: "Failed", deferred: "Deferred", conflicts: "Conflicts", history: "Operations and recent sync history",
    retryAll: "Retry eligible", refreshCache: "Refresh safe catalog cache", cached: "Catalog and stock are cached and may not represent live inventory.",
    created: "Created", attempted: "Last attempt", completed: "Completed", retries: "Attempts", originalBranch: "Original branch", originalUser: "Original user", retry: "Retry",
    noRows: "No local operations", noRowsHint: "Supported offline cash sales will appear here when captured.",
    sale: "Cash sale", lines: "Items", synced: "Synced", syncing: "Syncing", online: "Online", offline: "Offline", degraded: "Degraded", syncError: "Sync error", conflict: "Conflict", now: "Not yet", register: "Web POS",
    backendReachable: "Backend reachable", backendUnavailable: "Backend unavailable", backendUnknown: "Backend unknown",
  };

  const refresh = useCallback(async () => {
    setOperations(await listSafeSyncOperations(activeBranchId));
    await refreshSyncState();
  }, [activeBranchId, refreshSyncState]);

  useEffect(() => { void refresh(); }, [refresh, pos.syncPendingCount, pos.syncErrorCount, pos.syncDeferredCount, pos.syncConflictCount]);

  const retryOne = async (reference: string) => {
    if (busyRef) return;
    setBusyRef(reference);
    try {
      await pos.retrySyncItem(reference);
      await pos.reloadCatalog().catch(() => undefined);
      await refresh();
    } finally {
      setBusyRef(null);
    }
  };

  const refreshCatalog = async () => {
    if (pos.connectivityState === "offline" || pos.connectivitySnapshot.backend === "unavailable") return;
    setRefreshingCache(true);
    try {
      // This clears disposable product/variant rows only. Outbox, receipts,
      // lines and held carts are in separate stores and cannot be touched here.
      await clearDisposableCatalogCache();
      await pos.reloadCatalog();
    } finally {
      setRefreshingCache(false);
    }
  };

  const stateLabels = { online: copy.online, offline: copy.offline, syncing: copy.syncing, degraded: copy.degraded, sync_error: copy.syncError } as const;
  const operationLabels: Record<OfflineSyncStatus, string> = { pending: copy.pending, syncing: copy.syncing, synced: copy.synced, failed: copy.failed, deferred: copy.deferred, conflict: copy.conflict };
  const currentState = stateLabels[pos.connectivityState];
  const branchLabel = branch.current ? (ar ? branch.current.name_ar : branch.current.name_en) : "—";
  const stateTone = pos.connectivityState === "online" ? "success" : pos.connectivityState === "syncing" ? "info" : pos.connectivityState === "offline" ? "danger" : "warning";
  const totals = useMemo(() => [
    [copy.pending, pos.syncPendingCount, "warning"],
    [copy.failed, pos.syncErrorCount, "danger"],
    [copy.deferred, pos.syncDeferredCount, "warning"],
    [copy.conflicts, pos.syncConflictCount, "danger"],
  ] as const, [copy.conflicts, copy.deferred, copy.failed, copy.pending, pos.syncConflictCount, pos.syncDeferredCount, pos.syncErrorCount, pos.syncPendingCount]);

  return (
    <div data-testid="sync-center">
      <PageHeader title={copy.title} subtitle={copy.subtitle} actions={(
        <div className="flex flex-wrap gap-2">
          {mayRetrySales ? <Button variant="secondary" onClick={() => void pos.retrySync()} disabled={pos.connectivityState === "offline" || pos.connectivityState === "syncing"}>{copy.retryAll}</Button> : null}
          {mayRefreshCatalog ? <Button variant="secondary" loading={refreshingCache} onClick={() => void refreshCatalog()} disabled={pos.connectivityState !== "online"}>{copy.refreshCache}</Button> : null}
          {mayOpenHealth ? <Link to="/system-health" className="inline-flex items-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800">{copy.health}</Link> : null}
        </div>
      )} />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card><p className="text-[11px] font-bold uppercase text-stone-500">{copy.connectivity}</p><Badge tone={stateTone} className="mt-2">{currentState}</Badge><p className="mt-2 text-xs text-stone-500">{pos.connectivitySnapshot.backend === "reachable" ? copy.backendReachable : pos.connectivitySnapshot.backend === "unavailable" ? copy.backendUnavailable : copy.backendUnknown}</p></Card>
        <Card><p className="text-[11px] font-bold uppercase text-stone-500">{copy.currentBranch}</p><p className="mt-2 text-sm font-black text-stone-900">{branchLabel}</p><p dir="ltr" className="mt-1 truncate font-mono text-[10px] text-stone-500">{branch.current?.id ?? "—"}</p></Card>
        <Card><p className="text-[11px] font-bold uppercase text-stone-500">{copy.operator}</p><p className="mt-2 text-sm font-black text-stone-900">{user.name}</p><p className="mt-1 text-xs text-stone-500">{copy.register}</p></Card>
        <Card><p className="text-[11px] font-bold uppercase text-stone-500">{copy.lastSync}</p><p className="mt-2 text-sm font-black text-stone-900">{pos.lastSuccessfulSyncAt ? date(pos.lastSuccessfulSyncAt) : copy.now}</p></Card>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {totals.map(([label, value, tone]) => <Card key={label}><Badge tone={tone}>{label}</Badge><p className="mt-2 text-2xl font-black tabular-nums text-stone-900">{value}</p></Card>)}
      </div>

      {pos.workingFromCache ? <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">{copy.cached} {pos.cachedCatalogAt ? `${date(pos.cachedCatalogAt)}` : ""}</p> : null}

      <Card className="mt-4">
        <h2 className="text-sm font-black text-stone-900">{copy.history}</h2>
        {operations.length === 0 ? <div className="mt-4"><EmptyState icon="✓" title={copy.noRows} description={copy.noRowsHint} /></div> : (
          <ul className="mt-3 divide-y divide-stone-100">
            {operations.map((operation) => (
              <li key={operation.client_ref} className="py-3" data-testid={`sync-operation-${operation.client_ref}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2"><Badge tone={statusTone[operation.status]}>{operationLabels[operation.status]}</Badge><span className="text-sm font-black text-stone-900">{copy.sale}</span><span dir="ltr" className="font-mono text-[10px] text-stone-500">{operation.client_ref}</span></div>
                    <p className="mt-1 text-xs text-stone-600">{copy.created}: {date(operation.created_at)} · {copy.originalBranch}: <span dir="ltr" className="font-mono">{operation.branch_id === branch.current?.id ? branchLabel : operation.branch_id?.slice(0, 12) ?? "—"}</span> · {copy.originalUser}: {operation.user_name}</p>
                    <p className="mt-1 text-xs text-stone-600">{money(operation.total)} · {copy.lines}: {operation.lines.map((line) => `${line.sku}${line.color_en || line.color_ar ? ` · ${line.color_en || line.color_ar}` : ""}${line.size_value ? ` / ${line.size_value}` : ""} × ${line.qty}`).join("; ")}</p>
                    <p className="mt-1 text-[11px] text-stone-500">{copy.retries}: {operation.attempts} · {copy.attempted}: {operation.last_attempt_at ? date(operation.last_attempt_at) : copy.now}{operation.synced_at ? ` · ${copy.completed}: ${date(operation.synced_at)}` : ""}</p>
                    {operation.error_summary ? <p className="mt-1 max-w-3xl text-xs font-semibold text-rose-700">{operation.error_summary}</p> : null}
                  </div>
                  {operation.retryable && mayRetrySales ? <Button size="sm" variant="secondary" loading={busyRef === operation.client_ref} disabled={Boolean(busyRef) || pos.connectivityState === "offline"} onClick={() => void retryOne(operation.client_ref)}>{copy.retry}</Button> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
