/**
 * Discounts — automatic (codeless) offers.
 *
 * The storewide sale ("15% off everything"), a category offer, a product or a
 * variant offer. No code: the checkout applies the best applicable one by
 * priority, and it combines with a promo code only when both are stackable.
 * What a card shows struck-through is exactly what checkout charges, because
 * both read the same evaluation with the same rows.
 *
 * Reads are public (struck-through prices); every write is RLS-gated on
 * `manage_website` server-side, and this screen hides entirely without it.
 * Switching one on or off lands on the audit trail as activated/deactivated.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { canActAs } from "@/lib/permissions/enforce";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useAuth } from "@/lib/auth";
import { useCatalog } from "@/modules/products";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  LoadingBlock,
  Modal,
  SelectInput,
  TextInput,
  ToggleSwitch,
  useToast,
} from "@/components/ui";
import { getWebsiteRepository } from "../data";
import { toOnlineError, type OnlineErrorCode } from "../data/repository";
import type { Promotion, PromotionTarget, PromotionTargetDraft } from "../types";
import { fromDateTimeLocal, toDateTimeLocal } from "../services/datetime";
import { storefrontInvalidation } from "../hooks/storefrontInvalidation";

export function PromotionsPage() {
  const { t, pick, num, money, date } = useI18n();
  const toast = useToast();
  const { user } = useAuth();
  const repository = useMemo(() => getWebsiteRepository(), []);
  const canManage = canActAs(user, "manage_website");

  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [targets, setTargets] = useState<PromotionTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<OnlineErrorCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Promotion | null>(null);
  const [draftTargets, setDraftTargets] = useState<PromotionTargetDraft[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<Promotion | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await repository.listPromotions();
      const lists = await Promise.all(
        rows.map((promotion) => repository.listPromotionTargets(promotion.id)),
      );
      setPromotions(rows);
      setTargets(lists.flat());
      setError(null);
    } catch (caught) {
      setError(toOnlineError(caught).code);
    } finally {
      setLoading(false);
    }
  }, [repository]);

  useEffect(() => {
    if (canManage) void load();
    else setLoading(false);
  }, [canManage, load]);

  const openNew = () => {
    setDraft({
      id: "",
      enabled: true,
      name_en: "",
      name_ar: "",
      description_en: null,
      description_ar: null,
      discount_type: "percent",
      value: 10,
      scope: "store",
      minimum_order_amount: 0,
      maximum_discount_amount: null,
      starts_at: null,
      ends_at: null,
      priority: 0,
      stackable: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    setDraftTargets([]);
  };

  const openEdit = async (promotion: Promotion) => {
    setDraft(promotion);
    try {
      const rows = await repository.listPromotionTargets(promotion.id);
      setDraftTargets(rows.map((row) => ({ target_kind: row.target_kind, target_id: row.target_id })));
    } catch {
      setDraftTargets([]);
    }
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const saved = await repository.savePromotion(draft, draftTargets);
      setPromotions((current) => {
        const index = current.findIndex((entry) => entry.id === saved.id);
        if (index < 0) return [saved, ...current];
        const next = [...current];
        next[index] = saved;
        return next;
      });
      const fresh = await repository.listPromotionTargets(saved.id);
      setTargets((current) => [
        ...current.filter((entry) => entry.promotion_id !== saved.id),
        ...fresh,
      ]);
      setDraft(null);
      setDraftTargets([]);
      toast.success(t("online.promos.saved"));
      storefrontInvalidation.notify();
    } catch (caught) {
      toast.error(t(`online.error.${toOnlineError(caught).code}`));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirmDelete) return;
    setBusy(true);
    try {
      await repository.deletePromotion(confirmDelete.id);
      setPromotions((current) => current.filter((entry) => entry.id !== confirmDelete.id));
      setTargets((current) => current.filter((entry) => entry.promotion_id !== confirmDelete.id));
      toast.push(t("online.promos.deleted"), "info");
      storefrontInvalidation.notify();
      setConfirmDelete(null);
    } catch (caught) {
      toast.error(t(`online.error.${toOnlineError(caught).code}`));
    } finally {
      setBusy(false);
    }
  };

  const targetCount = (id: string) => targets.filter((entry) => entry.promotion_id === id).length;

  if (!canManage) {
    return (
      <div>
        <PageHeader
          title={t("online.promos.title")}
          crumbs={[{ label: t("home.breadcrumb.online"), to: "/online" }, { label: t("online.promos.title") }]}
          subtitle={t("online.promos.subtitle")}
        />
        <Card>
          <EmptyState icon="🔒" title={t("online.settings.noAccess")} description={t("online.settings.noAccessHint")} />
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={t("online.promos.title")}
        crumbs={[{ label: t("home.breadcrumb.online"), to: "/online" }, { label: t("online.promos.title") }]}
        subtitle={t("online.promos.subtitle")}
        actions={
          <Button data-testid="promo-new" onClick={openNew}>
            {t("online.promos.new")}
          </Button>
        }
      />

      {error ? (
        <ErrorState
          title={t("common.error")}
          message={t(`online.error.${error}`)}
          retryLabel={t("common.retry")}
          onRetry={() => void load()}
        />
      ) : loading ? (
        <div className="alyq-card">
          <LoadingBlock label={t("common.loading")} />
        </div>
      ) : promotions.length === 0 ? (
        <Card>
          <EmptyState icon="🏷️" title={t("online.promos.empty")} description={t("online.promos.emptyHint")} />
        </Card>
      ) : (
        <div className="alyq-card overflow-x-auto">
          <table className="w-full border-collapse text-sm" data-testid="promos-table">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50 text-[11px] font-bold uppercase tracking-wider text-stone-600">
                <th className="px-4 py-3 text-start font-semibold">{t("online.promos.colName")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("online.promos.colType")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("online.promos.colScope")}</th>
                <th className="px-3 py-3 text-end font-semibold">{t("online.promos.colValue")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("online.promos.colSchedule")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("online.promos.colStatus")}</th>
                <th className="px-4 py-3 text-end font-semibold">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {promotions.map((promotion) => (
                <tr
                  key={promotion.id}
                  data-testid={`promo-row-${promotion.id}`}
                  className="border-b border-stone-50 transition-colors last:border-0 hover:bg-slate-50/60"
                >
                  <td className="px-4 py-3">
                    <p className="text-sm font-bold text-stone-900">
                      {pick(promotion.name_ar, promotion.name_en)}
                    </p>
                    <p className="text-xs text-stone-500">
                      {t(`online.promos.scope.${promotion.scope}`)}
                      {promotion.scope !== "store"
                        ? ` · ${t("online.promos.targetCount", { count: num(targetCount(promotion.id), 0) })}`
                        : ""}
                    </p>
                  </td>
                  <td className="px-3 py-3 text-xs text-stone-700">
                    {promotion.discount_type === "percent"
                      ? t("online.marketing.percent")
                      : t("online.marketing.fixed")}
                  </td>
                  <td className="px-3 py-3 text-xs text-stone-700">
                    {t(`online.promos.scope.${promotion.scope}`)}
                  </td>
                  <td className="px-3 py-3 text-end text-sm font-bold tabular-nums text-stone-900">
                    {promotion.discount_type === "percent"
                      ? t("online.marketing.percentOff", { value: num(promotion.value, 0) })
                      : money(promotion.value)}
                    {promotion.maximum_discount_amount !== null
                      ? ` · ${t("online.marketing.cappedAt", { value: money(promotion.maximum_discount_amount) })}`
                      : ""}
                  </td>
                  <td className="px-3 py-3 text-xs text-stone-600">
                    {promotion.starts_at || promotion.ends_at
                      ? `${promotion.starts_at ? date(promotion.starts_at) : "—"} → ${
                          promotion.ends_at ? date(promotion.ends_at) : "—"
                        }`
                      : t("online.promos.alwaysOn")}
                  </td>
                  <td className="px-3 py-3">
                    <Badge tone={promotion.enabled ? "success" : "danger"}>
                      {promotion.enabled ? t("online.marketing.usable") : t("online.marketing.inactive")}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-end">
                    <div className="flex shrink-0 items-center justify-end gap-2">
                      <Button size="sm" variant="secondary" onClick={() => void openEdit(promotion)}>
                        {t("common.edit")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(promotion)}>
                        {t("common.delete")}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={draft !== null}
        onClose={() => {
          setDraft(null);
          setDraftTargets([]);
        }}
        size="lg"
        title={draft?.id ? t("online.promos.edit") : t("online.promos.new")}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setDraft(null);
                setDraftTargets([]);
              }}
              disabled={busy}
            >
              {t("common.cancel")}
            </Button>
            <Button
              data-testid="promo-save"
              onClick={() => void save()}
              loading={busy}
              disabled={
                !draft ||
                !draft.name_en.trim() ||
                !draft.name_ar.trim() ||
                draft.value <= 0 ||
                (draft.scope !== "store" && draftTargets.length === 0)
              }
            >
              {t("common.save")}
            </Button>
          </>
        }
      >
        {draft ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("online.promos.nameEn")} required>
                <TextInput
                  dir="ltr"
                  data-testid="promo-name-en"
                  value={draft.name_en}
                  onChange={(event) => setDraft({ ...draft, name_en: event.target.value })}
                />
              </Field>
              <Field label={t("online.promos.nameAr")} required>
                <TextInput
                  dir="rtl"
                  data-testid="promo-name-ar"
                  value={draft.name_ar}
                  onChange={(event) => setDraft({ ...draft, name_ar: event.target.value })}
                />
              </Field>
              <Field label={t("online.promos.type")}>
                <SelectInput
                  value={draft.discount_type}
                  onChange={(event) =>
                    setDraft({ ...draft, discount_type: event.target.value as Promotion["discount_type"] })
                  }
                >
                  <option value="percent">{t("online.marketing.percent")}</option>
                  <option value="fixed">{t("online.marketing.fixed")}</option>
                </SelectInput>
              </Field>
              <Field label={t("online.promos.value")} required>
                <TextInput
                  type="number"
                  min={0}
                  step="0.01"
                  data-testid="promo-value"
                  value={String(draft.value)}
                  onChange={(event) =>
                    setDraft({ ...draft, value: Math.max(0, Number(event.target.value) || 0) })
                  }
                />
              </Field>
              <Field label={t("online.promos.scope")}>
                <SelectInput
                  value={draft.scope}
                  onChange={(event) => {
                    const scope = event.target.value as Promotion["scope"];
                    setDraft({ ...draft, scope });
                    if (scope === "store") setDraftTargets([]);
                  }}
                >
                  <option value="store">{t("online.promos.scope.store")}</option>
                  <option value="category">{t("online.promos.scope.category")}</option>
                  <option value="product">{t("online.promos.scope.product")}</option>
                  <option value="variant">{t("online.promos.scope.variant")}</option>
                </SelectInput>
              </Field>
              <Field label={t("online.promos.priority")} hint={t("online.promos.priorityHint")}>
                <TextInput
                  type="number"
                  step={1}
                  value={String(draft.priority)}
                  onChange={(event) =>
                    setDraft({ ...draft, priority: Math.trunc(Number(event.target.value) || 0) })
                  }
                />
              </Field>
              <Field label={t("online.promos.minimum")} hint={t("online.promos.minimumHint")}>
                <TextInput
                  type="number"
                  min={0}
                  step="0.01"
                  value={String(draft.minimum_order_amount)}
                  onChange={(event) =>
                    setDraft({ ...draft, minimum_order_amount: Math.max(0, Number(event.target.value) || 0) })
                  }
                />
              </Field>
              <Field label={t("online.promos.maximum")} hint={t("online.promos.maximumHint")}>
                <TextInput
                  type="number"
                  min={0}
                  step="0.01"
                  disabled={draft.discount_type !== "percent"}
                  value={draft.maximum_discount_amount === null ? "" : String(draft.maximum_discount_amount)}
                  placeholder={t("online.marketing.uncapped")}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      maximum_discount_amount:
                        event.target.value.trim() === "" ? null : Math.max(0, Number(event.target.value) || 0),
                    })
                  }
                />
              </Field>
              <Field label={t("online.promos.startsAt")}>
                <TextInput
                  type="datetime-local"
                  value={toDateTimeLocal(draft.starts_at)}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      starts_at: event.target.value
                        ? fromDateTimeLocal(event.target.value, new Date().toISOString())
                        : null,
                    })
                  }
                />
              </Field>
              <Field label={t("online.promos.endsAt")}>
                <TextInput
                  type="datetime-local"
                  value={toDateTimeLocal(draft.ends_at)}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      ends_at: event.target.value ? fromDateTimeLocal(event.target.value, draft.starts_at ?? new Date().toISOString()) : null,
                    })
                  }
                />
              </Field>
            </div>

            <ToggleSwitch
              checked={draft.enabled}
              onChange={(checked) => setDraft({ ...draft, enabled: checked })}
              label={t("online.promos.enabled")}
              hint={t("online.promos.enabledHint")}
            />

            <ToggleSwitch
              checked={draft.stackable}
              onChange={(checked) => setDraft({ ...draft, stackable: checked })}
              label={t("online.marketing.stackable")}
              hint={t("online.marketing.stackableHint")}
            />

            {draft.scope !== "store" ? (
              <ScopePicker
                scope={draft.scope}
                selected={draftTargets}
                onChange={setDraftTargets}
              />
            ) : null}
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={confirmDelete !== null}
        title={t("online.promos.deleteTitle")}
        body={t("online.promos.deleteBody", { label: confirmDelete ? pick(confirmDelete.name_ar, confirmDelete.name_en) : "" })}
        loading={busy}
        onConfirm={() => void remove()}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}

/**
 * Scope target picker: categories, products or exact variants, as id rows.
 * Writes ids only — names stay in the catalogue, where a rename does not
 * leave a stale copy behind.
 */
function ScopePicker({
  scope,
  selected,
  onChange,
}: {
  scope: "category" | "product" | "variant";
  selected: { target_kind: PromotionTarget["target_kind"]; target_id: string }[];
  onChange: (targets: { target_kind: PromotionTarget["target_kind"]; target_id: string }[]) => void;
}) {
  const { t, pick } = useI18n();
  const { products, categories, variantsByProduct } = useCatalog();
  const [search, setSearch] = useState("");

  const options = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (scope === "category") {
      return categories
        .map((category) => ({ id: category.id, label: pick(category.name_ar, category.name_en), detail: "" }))
        .filter((option) => !needle || option.label.toLowerCase().includes(needle));
    }
    if (scope === "product") {
      return products
        .map((product) => ({ id: product.id, label: pick(product.name_ar, product.name_en), detail: product.sku }))
        .filter(
          (option) =>
            !needle ||
            option.label.toLowerCase().includes(needle) ||
            option.detail.toLowerCase().includes(needle),
        );
    }
    const rows: { id: string; label: string; detail: string }[] = [];
    for (const product of products) {
      for (const variant of variantsByProduct.get(product.id) ?? []) {
        rows.push({
          id: variant.id,
          label: `${pick(product.name_ar, product.name_en)} · ${pick(variant.color_ar, variant.color_en) ?? ""} ${variant.size ?? variant.size_label ?? ""}`.trim(),
          detail: variant.sku,
        });
      }
    }
    return rows.filter(
      (option) =>
        !needle ||
        option.label.toLowerCase().includes(needle) ||
        option.detail.toLowerCase().includes(needle),
    );
  }, [categories, pick, products, scope, search, variantsByProduct]);

  const toggle = (id: string) => {
    const kind = scope === "category" ? "category" : scope === "product" ? "product" : "variant";
    onChange(
      selected.some((entry) => entry.target_id === id)
        ? selected.filter((entry) => entry.target_id !== id)
        : [...selected, { target_kind: kind, target_id: id }],
    );
  };

  return (
    <div className="rounded-xl border border-slate-200 p-3" data-testid="promo-target-picker">
      <p className="text-xs font-bold text-slate-800">{t("online.promos.chooseTargets")}</p>
      <p className="mt-0.5 text-[11px] font-medium text-slate-500">{t("online.promos.chooseTargetsHint")}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <TextInput
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("common.search")}
          className="h-9 flex-1 text-xs"
          aria-label={t("common.search")}
        />
        <span className="text-xs font-bold text-slate-600">
          {t("online.promos.selectedCount", { count: selected.length })}
        </span>
        {selected.length > 0 ? (
          <Button size="sm" variant="ghost" onClick={() => onChange([])}>
            {t("online.marketing.clearSelection")}
          </Button>
        ) : null}
      </div>
      <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50/60 p-2">
        {options.slice(0, 200).map((option) => (
          <li key={option.id}>
            <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-white">
              <input
                type="checkbox"
                checked={selected.some((entry) => entry.target_id === option.id)}
                onChange={() => toggle(option.id)}
                className="accent-indigo-600"
              />
              <span className="min-w-0 flex-1 truncate font-semibold text-slate-800">{option.label}</span>
              {option.detail ? (
                <span className="shrink-0 font-mono text-[10px] text-slate-500">{option.detail}</span>
              ) : null}
            </label>
          </li>
        ))}
        {options.length === 0 ? (
          <li className="px-2 py-3 text-center text-xs font-semibold text-slate-500">
            {t("online.marketing.noMatches")}
          </li>
        ) : null}
      </ul>
    </div>
  );
}
