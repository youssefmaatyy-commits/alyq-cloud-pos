import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  ExportButton,
  LoadingBlock,
  SearchIcon,
  SelectInput,
  TextInput,
} from "@/components/ui";
import type { TranslationKey } from "@/lib/i18n/I18nProvider";
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  EMPTY_AUDIT_FILTERS,
  type AuditFiltersValue,
  type AuditLogEntry,
} from "../types";
import {
  assertCanExportAudit,
  auditActors,
  loadAuditLog,
  mayExportAudit,
  queryAuditLog,
} from "../services/auditService";
import { buildAuditSheets } from "../services/auditExport";

const ACTION_TONE: Record<string, "success" | "info" | "warning" | "danger" | "neutral"> = {
  "shift.opened": "success",
  "shift.closed": "info",
  "expense.created": "warning",
  "expense.updated": "neutral",
  "expense.deleted": "danger",
  "shift.adjustment.approved": "success",
  "return.created": "info",
  // Money the shop chose not to charge, and an invoice it chose to un-sell.
  "sale.discounted": "warning",
  "sale.voided": "danger",
  // A margin decision and a supplier fact: both change what profit means.
  "product.price_changed": "info",
  "product.cost_changed": "info",
  // A correction is the stronger statement — the system was wrong.
  "stock.adjusted": "neutral",
  "stock.corrected": "warning",
  "approval.requested": "warning",
  "approval.approved": "success",
  "approval.rejected": "danger",
  "approval.cancelled": "neutral",
  "approval.applied": "success",
  "approval_rules.updated": "info",
};

/** Read-only audit trail (Phase 8). */
export function AuditLogPage() {
  const { t, date } = useI18n();
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<AuditFiltersValue>(EMPTY_AUDIT_FILTERS);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await loadAuditLog());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => queryAuditLog(entries, filters), [entries, filters]);
  // The "who" filter offers the people actually in the trail: a roster of every
  // employee would list names that never did anything, and a free-text box would
  // make the filter depend on spelling a name exactly as it was written down.
  const actors = useMemo(() => auditActors(entries), [entries]);
  const mayExport = useMemo(() => mayExportAudit(), []);
  const filtersActive =
    filters.search.trim() !== "" ||
    filters.action !== "all" ||
    filters.entity !== "all" ||
    filters.user !== "all" ||
    filters.from !== "" ||
    filters.to !== "";

  return (
    <div>
      <PageHeader
        title={t("audit.title")}
        subtitle={t("audit.subtitle")}
        actions={
          <>
            {/* Extract of exactly what is on screen — the filters are the query.
                Rendered only for somebody who may both read the trail and take
                it out (`audit.view` + `audit.export`), and asserted again at
                click time, because a hidden button is a courtesy, not a gate. */}
            {mayExport && (
              <ExportButton
                name="audit-log"
                count={filtered.length}
                build={() => {
                  assertCanExportAudit();
                  return buildAuditSheets({ entries: filtered, t });
                }}
              />
            )}
            <Button variant="secondary" onClick={() => void refresh()}>
              ⟳ {t("common.refresh")}
            </Button>
          </>
        }
      />

      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-full sm:max-w-xs">
            <TextInput
              value={filters.search}
              leading={<SearchIcon />}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })}
              placeholder={t("audit.searchPlaceholder")}
              aria-label={t("common.search")}
              type="search"
            />
          </div>
          <div className="w-full sm:w-56">
            <SelectInput
              value={filters.action}
              onChange={(e) =>
                setFilters({ ...filters, action: e.target.value as AuditFiltersValue["action"] })
              }
              aria-label={t("audit.action")}
            >
              <option value="all">{t("audit.allActions")}</option>
              {AUDIT_ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {t(`audit.action.${action}` as TranslationKey)}
                </option>
              ))}
            </SelectInput>
          </div>
          <div className="w-full sm:w-48">
            <SelectInput
              value={filters.entity}
              onChange={(e) =>
                setFilters({ ...filters, entity: e.target.value as AuditFiltersValue["entity"] })
              }
              aria-label={t("audit.entity")}
            >
              <option value="all">{t("audit.allEntities")}</option>
              {AUDIT_ENTITIES.map((entity) => (
                <option key={entity} value={entity}>
                  {t(`audit.entity.${entity}` as TranslationKey)}
                </option>
              ))}
            </SelectInput>
          </div>
          <div className="w-full sm:w-48">
            <SelectInput
              value={filters.user}
              onChange={(e) => setFilters({ ...filters, user: e.target.value })}
              aria-label={t("audit.user")}
            >
              <option value="all">{t("audit.allUsers")}</option>
              {actors.map((actor) => (
                <option key={actor.id} value={actor.id}>
                  {actor.name}
                </option>
              ))}
            </SelectInput>
          </div>
          <div className="w-full sm:w-40">
            <TextInput
              type="date"
              value={filters.from}
              max={filters.to || undefined}
              onChange={(e) => setFilters({ ...filters, from: e.target.value })}
              aria-label={t("audit.from")}
            />
          </div>
          <div className="w-full sm:w-40">
            <TextInput
              type="date"
              value={filters.to}
              min={filters.from || undefined}
              onChange={(e) => setFilters({ ...filters, to: e.target.value })}
              aria-label={t("audit.to")}
            />
          </div>
          {filtersActive ? (
            <Button variant="ghost" size="sm" onClick={() => setFilters(EMPTY_AUDIT_FILTERS)}>
              {t("export.clear")}
            </Button>
          ) : null}
        </div>
        <p className="mt-2 text-[11px] font-medium text-slate-500">
          {t("audit.filterHint", { count: filtered.length })}
        </p>
      </Card>

      {error ? (
        <ErrorState title={t("common.error")} message={error} retryLabel={t("common.retry")} onRetry={() => void refresh()} />
      ) : loading ? (
        <div className="alyq-card">
          <LoadingBlock label={t("common.loading")} />
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <EmptyState icon="🧾" title={t("audit.empty")} description={t("audit.emptyHint")} />
        </Card>
      ) : (
        <div className="alyq-card overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-bold uppercase tracking-wider text-slate-600">
                <th className="px-4 py-3 text-start font-semibold">{t("audit.when")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("audit.action")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("audit.entity")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("audit.record")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("audit.details")}</th>
                <th className="px-4 py-3 text-start font-semibold">{t("pos.cols.user")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((entry) => (
                <tr key={entry.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                  <td className="px-4 py-3 text-xs text-slate-500" dir="ltr">
                    {date(entry.created_at)}
                  </td>
                  <td className="px-3 py-3">
                    <Badge tone={ACTION_TONE[entry.action] ?? "neutral"}>
                      {t(`audit.action.${entry.action}` as TranslationKey)}
                    </Badge>
                  </td>
                  <td className="px-3 py-3 text-xs text-slate-500">
                    {t(`audit.entity.${entry.entity}` as TranslationKey)}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs font-bold text-slate-800">
                    {entry.entity_label}
                  </td>
                  <td className="px-3 py-3 text-xs text-slate-600">
                    {Object.entries(entry.details)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(" · ")}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-700">{entry.user_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
