import { useI18n } from "@/lib/i18n/I18nProvider";
import { usePos } from "../hooks/PosProvider";

/**
 * Part 7's "clearly visible connectivity/sync area" — lives in the Current
 * Sale card's FIXED header, next to the customer row, so it never scrolls
 * out of view while cart lines do. Visual identity matches the rest of the
 * till: warm stone cards, amber for attention states, emerald for the quiet
 * "all good" state — no blue.
 *
 * Priority when several things are true at once: a sync error is the most
 * actionable (someone should look at it), then an offline banner, then a
 * plain pending count, then a brief "online, nothing to report" state that
 * takes almost no room.
 */
export function ConnectivityIndicator() {
  const { t, date } = useI18n();
  const {
    connectivity,
    syncPendingCount,
    syncErrorCount,
    syncConflictCount,
    syncing,
    lastSyncedAt,
    workingFromCache,
    catalogCachedAt,
    retrySync,
  } = usePos();

  const hasErrors = syncErrorCount + syncConflictCount > 0;
  const hasPending = syncPendingCount > 0;

  if (connectivity === "offline") {
    return (
      <div
        data-testid="pos-connectivity-offline"
        className="mt-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2"
      >
        <div className="flex items-center gap-2">
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
          <p className="text-xs font-bold text-amber-900">{t("pos.offline.offline")}</p>
        </div>
        <p className="mt-0.5 text-[11px] font-semibold text-amber-800">{t("pos.offline.offlineHint")}</p>
        {(hasPending || hasErrors) && (
          <SyncCountsLine
            pending={syncPendingCount}
            errors={syncErrorCount}
            conflicts={syncConflictCount}
            syncing={syncing}
            onRetry={retrySync}
            tone="amber"
          />
        )}
        {workingFromCache && (
          <p className="mt-1 text-[10px] font-semibold text-amber-700">
            {t("pos.offline.workingFromCache")}
            {catalogCachedAt ? ` — ${t("pos.offline.catalogCachedAt", { time: date(catalogCachedAt) })}` : ""}
          </p>
        )}
      </div>
    );
  }

  if (hasErrors) {
    return (
      <div
        data-testid="pos-connectivity-error"
        className="mt-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2"
      >
        <div className="flex items-center gap-2">
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-rose-500" />
          <p className="text-xs font-bold text-rose-900">{t("pos.offline.syncError")}</p>
        </div>
        <p className="mt-0.5 text-[11px] font-semibold text-rose-800">{t("pos.offline.syncErrorHint")}</p>
        <SyncCountsLine
          pending={syncPendingCount}
          errors={syncErrorCount}
          conflicts={syncConflictCount}
          syncing={syncing}
          onRetry={retrySync}
          tone="rose"
        />
      </div>
    );
  }

  if (hasPending || syncing) {
    return (
      <div
        data-testid="pos-connectivity-pending"
        className="mt-2 rounded-xl border border-stone-200 bg-stone-50 px-3 py-2"
      >
        <div className="flex items-center gap-2">
          <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${syncing ? "animate-pulse bg-amber-500" : "bg-emerald-500"}`} />
          <p className="text-xs font-bold text-stone-900">{t("pos.offline.online")}</p>
        </div>
        <SyncCountsLine
          pending={syncPendingCount}
          errors={syncErrorCount}
          conflicts={syncConflictCount}
          syncing={syncing}
          onRetry={retrySync}
          tone="stone"
        />
      </div>
    );
  }

  return (
    <div data-testid="pos-connectivity-online" className="mt-1.5 flex items-center gap-1.5 px-0.5">
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
      <p className="text-[10px] font-semibold text-stone-500">
        {t("pos.offline.online")}
        {lastSyncedAt ? ` · ${t("pos.offline.lastSynced", { time: date(lastSyncedAt) })}` : ""}
      </p>
    </div>
  );
}

function SyncCountsLine({
  pending,
  errors,
  conflicts,
  syncing,
  onRetry,
  tone,
}: {
  pending: number;
  errors: number;
  conflicts: number;
  syncing: boolean;
  onRetry: () => void;
  tone: "amber" | "rose" | "stone";
}) {
  const { t, tPlural } = useI18n();
  const total = pending + errors + conflicts;
  if (total === 0 && !syncing) return null;
  const textClass = tone === "amber" ? "text-amber-800" : tone === "rose" ? "text-rose-800" : "text-stone-700";
  const buttonClass =
    tone === "amber"
      ? "border-amber-400 bg-white text-amber-900 hover:bg-amber-100"
      : tone === "rose"
        ? "border-rose-400 bg-white text-rose-900 hover:bg-rose-100"
        : "border-stone-300 bg-white text-stone-800 hover:bg-stone-100";
  return (
    <div className="mt-1 flex items-center justify-between gap-2">
      <p className={`text-[11px] font-bold ${textClass}`} data-testid="pos-sync-summary">
        {syncing ? t("pos.offline.syncing") : total > 0 ? tPlural("pos.offline.pendingCount", total, { count: total }) : ""}
        {conflicts > 0 ? ` · ${t("pos.offline.conflictDetected")}` : ""}
      </p>
      {total > 0 && (
        <button
          type="button"
          onClick={onRetry}
          disabled={syncing}
          data-testid="pos-retry-sync"
          className={`shrink-0 rounded-lg border px-2 py-0.5 text-[11px] font-bold transition ${buttonClass} disabled:opacity-60`}
        >
          {syncing ? t("pos.offline.retrying") : t("pos.offline.retry")}
        </button>
      )}
    </div>
  );
}
