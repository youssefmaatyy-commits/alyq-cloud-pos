/**
 * Settings → Operations Center (Phase 56).
 *
 * One screen for notifications, health, usage, storage, and cleanup.
 * Preview never writes. Confirm re-checks the phrase and the capability.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { canAct } from "@/lib/permissions/enforce";
import { operationsAccess } from "@/lib/permissions/workspaces";
import { isSupabaseConfigured, getSupabaseClient } from "@/lib/supabase/client";
import { PageHeader } from "@/components/layout/AppShell";
import { Badge, Button, Card, EmptyState, TextInput } from "@/components/ui";
import { useCatalog } from "@/modules/products";
import { useCustomers } from "@/modules/customers";
import { usePos } from "@/modules/pos";
import { useReturns } from "@/modules/returns";
import { useOnlineOrders } from "@/modules/online/hooks/OnlineOrdersProvider";
import { useShifts } from "@/modules/shifts";
import { listStocktakes } from "@/modules/inventory/services/stocktake";
import { loadStatus } from "@/modules/backup/services/backupService";
import { getWebsiteRepository } from "@/modules/online/data";
import type { BackupStatus } from "@/modules/backup/types";
import { buildOperationalNotifications, markAllNotificationsRead, markNotificationRead } from "../services/notifications";
import { collectMediaReferences, collectUrlsFromDocument, findOrphans, mergeSeenReferences } from "../services/mediaAudit";
import { buildCleanupPlan, isEligibleKind, retentionCandidates } from "../services/cleanup";
import { buildHealthReport } from "../services/health";
import { buildUsageReport, sumRegisteredBytes } from "../services/usage";
import { commitCleanup } from "../services/operationsService";
import {
  loadMediaRegistry,
  loadReadIds,
  loadStorageWarningBytes,
  saveMediaRegistry,
  saveReadIds,
  saveStorageWarningBytes,
} from "../services/store";
import { CLEANUP_PHRASE, DEFAULT_RETENTION_DAYS, RETENTION_PHRASE, type CleanupPlan, type NotificationKind } from "../types";

type Tab = "overview" | "notifications" | "usage" | "storage" | "cleanup" | "retention" | "diagnostics";

const TABS: Tab[] = ["overview", "notifications", "usage", "storage", "cleanup", "retention", "diagnostics"];

export function OperationsCenterPage() {
  const { t } = useI18n();
  const access = operationsAccess(canAct);
  const allowed = access.view;
  const [tab, setTab] = useState<Tab>("overview");
  const catalog = useCatalog();
  const { customers } = useCustomers();
  const { sales } = usePos();
  const { returnsList } = useReturns();
  const { orders } = useOnlineOrders();
  const { shifts } = useShifts();
  const [readIds, setReadIds] = useState<string[]>(() => loadReadIds());
  const [files, setFiles] = useState(() => loadMediaRegistry());
  const [threshold, setThreshold] = useState<string>(() => {
    const current = loadStorageWarningBytes();
    return current === null ? "" : String(current);
  });
  const [websiteUrls, setWebsiteUrls] = useState<{ ownerId: string; url: string }[]>([]);
  const [promotions, setPromotions] = useState<{ id: string; name: string; enabled: boolean; endsAt: string | null }[]>([]);
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null);
  const [backupCount, setBackupCount] = useState<number | null>(null);
  const [backupAt, setBackupAt] = useState<string | null>(null);
  const [supabaseReachable, setSupabaseReachable] = useState<boolean | null>(isSupabaseConfigured ? null : false);
  const [kindFilter, setKindFilter] = useState<NotificationKind | "all">("all");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [plan, setPlan] = useState<CleanupPlan | null>(null);
  const [phrase, setPhrase] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [retentionDays, setRetentionDays] = useState(String(DEFAULT_RETENTION_DAYS));

  useEffect(() => {
    let cancelled = false;
    const website = getWebsiteRepository();
    website
      .getSettings()
      .then((settings) => {
        if (!cancelled) setWebsiteUrls(collectUrlsFromDocument(settings, "website"));
      })
      .catch(() => {
        if (!cancelled) setWebsiteUrls([]);
      });
    website
      .listPromotions()
      .then((rows) => {
        if (!cancelled) {
          setPromotions(rows.map((row) => ({ id: row.id, name: row.name_en || row.name_ar, enabled: row.enabled, endsAt: row.ends_at })));
        }
      })
      .catch(() => {
        if (!cancelled) setPromotions([]);
      });
    if (canAct("view_backups")) {
      loadStatus()
        .then((status) => {
          if (cancelled) return;
          setBackupStatus(status.status);
          setBackupCount(status.backup_count);
          setBackupAt(status.last_backup?.created_at ?? null);
        })
        .catch(() => {
          if (!cancelled) setBackupStatus(null);
        });
    }
    if (!isSupabaseConfigured) {
      setSupabaseReachable(false);
      return () => {
        cancelled = true;
      };
    }
    const client = getSupabaseClient();
    if (!client) {
      setSupabaseReachable(false);
      return () => {
        cancelled = true;
      };
    }
    void Promise.resolve(
      client.from("categories").select("id").limit(1),
    ).then(
      ({ error }) => {
        if (!cancelled) setSupabaseReachable(!error);
      },
      () => {
        if (!cancelled) setSupabaseReachable(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const variantProductIds = useMemo(() => {
    const ids = new Set<string>();
    for (const variant of catalog.variants) {
      if (variant.active) ids.add(variant.product_id);
    }
    return ids;
  }, [catalog.variants]);

  const stock = useMemo(() => {
    const signals = [];
    for (const product of catalog.products) {
      if (variantProductIds.has(product.id)) continue;
      signals.push({
        id: product.id,
        quantity: product.stock_quantity,
        lowLevel: product.low_stock_level,
        tracked: product.stock_tracking_enabled,
        active: product.active,
        updatedAt: product.updated_at,
        label: product.sku,
      });
    }
    for (const variant of catalog.variants) {
      signals.push({
        id: variant.id,
        quantity: variant.stock_quantity,
        lowLevel: variant.low_stock_level,
        tracked: true,
        active: variant.active,
        updatedAt: variant.updated_at,
        label: variant.sku,
      });
    }
    return signals;
  }, [catalog.products, catalog.variants, variantProductIds]);

  const capabilities = useMemo(() => {
    const known = [
      "view_inventory",
      "manage_online_orders",
      "process_return",
      "approve_shift_adjustment",
      "manage_website",
      "view_backups",
      "manage_settings",
      "run_health_check",
    ] as const;
    return new Set(known.filter((capability) => canAct(capability)));
  }, []);

  const warningBytes = loadStorageWarningBytes();
  const notifications = useMemo(
    () =>
      buildOperationalNotifications(
        {
          stock,
          orders: orders.map((order) => ({
            id: order.id,
            number: order.order_number,
            status: order.status,
            createdAt: order.created_at,
          })),
          returns: returnsList.map((entry) => ({
            id: entry.id,
            number: entry.return_number,
            refundStatus: entry.refund_status,
            createdAt: entry.created_at,
          })),
          shifts: shifts.map((shift) => ({
            id: shift.id,
            number: shift.shift_number,
            status: shift.status,
            difference: shift.summary?.difference ?? null,
            adjustmentApprovedAt: shift.adjustment_approved_at,
            closedAt: shift.closed_at,
          })),
          promotions,
          stocktakes: listStocktakes().map((session) => ({
            id: session.id,
            status: session.status,
            createdAt: session.createdAt,
          })),
          backupStatus,
          backupAt,
          storageUsedBytes: sumRegisteredBytes(files),
          storageWarningBytes: warningBytes,
          supabase: !isSupabaseConfigured ? "not_configured" : supabaseReachable === null ? "pending" : supabaseReachable ? "ok" : "unavailable",
        },
        capabilities,
        new Date().toISOString(),
        new Set(readIds),
      ),
    [stock, orders, returnsList, shifts, promotions, backupStatus, backupAt, files, warningBytes, supabaseReachable, capabilities, readIds],
  );

  const references = useMemo(
    () =>
      collectMediaReferences({
        products: catalog.products,
        variants: catalog.variants,
        websiteUrls,
        backupIds: [],
      }),
    [catalog.products, catalog.variants, websiteUrls],
  );
  const orphans = useMemo(
    () => findOrphans(files, references).filter((file) => isEligibleKind(file.kind)),
    [files, references],
  );

  useEffect(() => {
    setFiles((current) => {
      const merged = mergeSeenReferences(current, references, new Date().toISOString());
      if (merged.length === current.length && merged.every((file, index) => file.id === current[index]?.id)) return current;
      saveMediaRegistry(merged);
      return merged;
    });
  }, [references]);
  const usage = buildUsageReport({
    products: catalog.products.length,
    variants: catalog.variants.length,
    customers: customers.length,
    sales: sales.length,
    onlineOrders: orders.length,
    returns: returnsList.length,
    referencedImages: references.filter((ref) => ref.location === "product" || ref.location === "variant" || ref.location === "website").length,
    backupFiles: backupCount,
    orphanFiles: orphans.length,
    registeredBytes: sumRegisteredBytes(files),
  });
  const health = buildHealthReport({
    supabaseConfigured: isSupabaseConfigured,
    supabaseReachable: isSupabaseConfigured ? supabaseReachable : null,
    backupStatus,
    backupCount,
    appliedMigrationCount: null,
    recentErrors: [],
    storageListing: "unavailable",
  });

  if (!allowed) {
    return (
      <div>
        <PageHeader title={t("operations.title")} subtitle={t("operations.subtitle")} />
        <Card>
          <EmptyState icon="🔒" title={t("perm.denied")} description={t("operations.denied")} />
        </Card>
      </div>
    );
  }

  const visible = notifications.filter((note) => {
    if (unreadOnly && note.read) return false;
    if (kindFilter !== "all" && note.kind !== kindFilter) return false;
    return true;
  });

  const persistRead = (next: string[]) => {
    setReadIds(next);
    saveReadIds(next);
  };

  const preview = () => {
    setResult(null);
    setPlan(buildCleanupPlan(files, references, selected, new Date().toISOString(), Number(retentionDays) || DEFAULT_RETENTION_DAYS));
  };

  const confirm = async (mode: "cleanup" | "retention") => {
    if (!plan) return;
    try {
      const outcome = await commitCleanup({
        files,
        references,
        plan,
        phrase,
        mode,
      });
      setFiles(outcome.files);
      saveMediaRegistry(outcome.files);
      setSelected([]);
      setPlan(null);
      setPhrase("");
      setResult(t("operations.cleanup.result", { count: outcome.deleted }));
    } catch {
      setResult(t("operations.cleanup.phraseHint"));
    }
  };

  return (
    <div data-testid="operations-center">
      <PageHeader
        title={t("operations.title")}
        subtitle={t("operations.subtitle")}
        crumbs={[{ label: t("nav.dashboard"), to: "/" }, { label: t("admin.settings.title"), to: "/settings" }, { label: t("operations.title") }]}
      />
      <div className="mb-4 flex flex-wrap gap-1">
        {TABS.filter((key) => access.cleanup || (key !== "storage" && key !== "cleanup" && key !== "retention")).map((key) => (
          <button
            key={key}
            type="button"
            data-testid={`operations-tab-${key}`}
            onClick={() => setTab(key)}
            className={`rounded-full px-3 py-1 text-xs font-bold ${tab === key ? "bg-stone-900 text-white" : "bg-white text-stone-700 ring-1 ring-stone-200"}`}
          >
            {t(`operations.tab.${key}`)}
          </button>
        ))}
      </div>

      {tab === "overview" || tab === "diagnostics" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {health.map((fact) => (
            <Card key={fact.key}>
              <p className="text-[11px] font-bold uppercase tracking-wide text-stone-500">{t(`operations.health.${fact.key}`)}</p>
              <p className="mt-1 text-sm font-bold text-stone-900">{t(`operations.health.state.${fact.state}`)}</p>
              {fact.detail ? (
                <p className="mt-1 text-xs text-stone-600">
                  {fact.detail === "credentials" ? t("operations.notAvailableCredentials") : fact.detail}
                </p>
              ) : null}
            </Card>
          ))}
          <p className="text-xs text-stone-500 sm:col-span-2">{t("operations.stocktake.localNote")}</p>
        </div>
      ) : null}

      {tab === "notifications" ? (
        <Card className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs font-bold text-stone-600">
              {t("operations.notifications.filter")}
              <select
                className="ms-2 rounded-lg border border-stone-200 px-2 py-1"
                value={kindFilter}
                onChange={(event) => setKindFilter(event.target.value as NotificationKind | "all")}
              >
                <option value="all">{t("operations.notifications.all")}</option>
                {(["low_stock", "out_of_stock", "online_order", "return_pending", "shift_discrepancy", "promotion_expiring", "stocktake_open", "backup_warning", "storage_warning", "system_warning"] as const).map((kind) => (
                  <option key={kind} value={kind}>{t(`operations.kind.${kind}`)}</option>
                ))}
              </select>
            </label>
            <label className="text-xs font-semibold text-stone-700">
              <input type="checkbox" className="me-1" checked={unreadOnly} onChange={(event) => setUnreadOnly(event.target.checked)} />
              {t("operations.notifications.unread")}
            </label>
            <Button type="button" variant="secondary" onClick={() => persistRead(markAllNotificationsRead(readIds, notifications))}>
              {t("operations.notifications.markAll")}
            </Button>
          </div>
          {visible.length === 0 ? (
            <EmptyState icon="○" title={t("operations.notifications.empty")} description={t("operations.subtitle")} />
          ) : (
            <ul className="divide-y divide-stone-100">
              {visible.map((note) => (
                <li key={note.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div>
                    <Badge tone={note.read ? "neutral" : "warning"}>{t(`operations.kind.${note.kind}`)}</Badge>
                    <Link to={note.href} className="ms-2 text-sm font-bold text-stone-900 hover:underline">
                      {note.label}
                    </Link>
                    <p className="text-[11px] text-stone-500" dir="ltr">{note.at}</p>
                  </div>
                  {!note.read ? (
                    <Button type="button" size="sm" variant="ghost" onClick={() => persistRead(markNotificationRead(readIds, note.id))}>
                      {t("operations.notifications.markRead")}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {tab === "usage" ? (
        <Card className="space-y-3">
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            {(
              [
                ["products", usage.counts.products],
                ["variants", usage.counts.variants],
                ["customers", usage.counts.customers],
                ["sales", usage.counts.sales],
                ["orders", usage.counts.onlineOrders],
                ["returns", usage.counts.returns],
                ["images", usage.counts.referencedImages],
                ["orphans", usage.counts.orphanFiles],
              ] as const
            ).map(([key, value]) => (
              <div key={key}>
                <dt className="text-[11px] font-bold uppercase text-stone-500">{t(`operations.usage.${key}`)}</dt>
                <dd className="font-bold tabular-nums text-stone-900">{value}</dd>
              </div>
            ))}
            <div>
              <dt className="text-[11px] font-bold uppercase text-stone-500">{t("operations.usage.backups")}</dt>
              <dd className="font-bold text-stone-900">{usage.counts.backupFiles === null ? t("operations.unavailable") : usage.counts.backupFiles}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-bold uppercase text-stone-500">{t("operations.usage.databaseSize")}</dt>
              <dd className="text-xs font-semibold text-stone-600">{t("operations.notAvailableCredentials")}</dd>
            </div>
          </dl>
          <p className="text-xs text-stone-500">{t("operations.usage.estimateNote")}</p>
          {access.cleanup ? (
            <>
              <label className="block text-xs font-bold text-stone-700">
                {t("operations.usage.threshold")}
                <TextInput
                  className="mt-1 max-w-xs"
                  value={threshold}
                  inputMode="numeric"
                  onChange={(event) => setThreshold(event.target.value)}
                  placeholder={t("operations.usage.thresholdHint")}
                />
              </label>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  const parsed = Number(threshold);
                  const next = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
                  saveStorageWarningBytes(next);
                  setThreshold(next === null ? "" : String(next));
                }}
              >
                {t("common.save")}
              </Button>
            </>
          ) : null}
        </Card>
      ) : null}

      {access.cleanup && (tab === "storage" || tab === "cleanup" || tab === "retention") ? (
        <Card className="space-y-3">
          <p className="text-xs leading-relaxed text-stone-600">{t("operations.storage.backupNote")}</p>
          <p className="text-xs font-semibold text-stone-700">{t("operations.cleanup.protected")}</p>
          {tab === "retention" ? (
            <label className="block text-xs font-bold text-stone-700">
              {t("operations.retention.days")}
              <TextInput className="mt-1 max-w-[8rem]" value={retentionDays} onChange={(event) => setRetentionDays(event.target.value)} />
            </label>
          ) : null}
          {orphans.length === 0 ? (
            <EmptyState icon="○" title={t("operations.cleanup.empty")} description={t("operations.retention.none")} />
          ) : (
            <ul className="divide-y divide-stone-100 text-sm">
              {orphans.map((file) => (
                <li key={file.id} className="flex items-center justify-between gap-2 py-2">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selected.includes(file.id)}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked ? [...current, file.id] : current.filter((id) => id !== file.id),
                        )
                      }
                    />
                    <span className="font-mono text-xs" dir="ltr">{file.path}</span>
                  </label>
                  <span className="text-[11px] font-bold text-stone-500">{t(`operations.storage.${file.kind === "temporary" ? "temporary" : "orphan"}`)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={preview}>{t("operations.cleanup.preview")}</Button>
            {tab === "retention" ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  const days = Number(retentionDays) || DEFAULT_RETENTION_DAYS;
                  const items = retentionCandidates(files, references, new Date().toISOString(), days);
                  setPlan({ items, refused: [], protectedNote: t("operations.cleanup.protected") });
                  setSelected(items.map((item) => item.id));
                }}
              >
                {t("operations.retention.title")}
              </Button>
            ) : null}
          </div>
          {plan ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm" data-testid="operations-cleanup-preview">
              <p className="font-bold text-amber-950">{t("operations.cleanup.preview")}: {plan.items.length}</p>
              <p className="mt-1 text-xs text-amber-900">{plan.protectedNote}</p>
              <ul className="mt-2 space-y-1 text-xs">
                {plan.items.map((item) => (
                  <li key={item.id} dir="ltr">{item.path} · {item.bytes ?? "—"} · {item.reason}</li>
                ))}
              </ul>
              {plan.refused.length > 0 ? (
                <p className="mt-2 text-xs">{t("operations.cleanup.why")}: {plan.refused.map((item) => `${item.id} ${item.reason}`).join(", ")}</p>
              ) : null}
              <label className="mt-3 block text-xs font-bold text-stone-800">
                {t("operations.cleanup.phrase")}
                <TextInput className="mt-1" value={phrase} onChange={(event) => setPhrase(event.target.value)} placeholder={CLEANUP_PHRASE} />
              </label>
              <div className="mt-2 flex gap-2">
                <Button type="button" disabled={plan.items.length === 0} onClick={() => void confirm(tab === "retention" ? "retention" : "cleanup")}>
                  {t("operations.cleanup.confirm")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setPlan(null);
                    setPhrase("");
                  }}
                >
                  {t("operations.cleanup.cancel")}
                </Button>
              </div>
              <p className="mt-1 font-mono text-[11px] text-stone-500" dir="ltr">{tab === "retention" ? RETENTION_PHRASE : CLEANUP_PHRASE}</p>
            </div>
          ) : null}
          {result ? <p className="text-xs font-semibold text-stone-700">{result}</p> : null}
          <p className="text-xs text-stone-500">{t("operations.retention.noArchive")}</p>
        </Card>
      ) : null}
    </div>
  );
}
