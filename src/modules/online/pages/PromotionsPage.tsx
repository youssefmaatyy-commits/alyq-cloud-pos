/**
 * Discounts & Promotions — Central Admin Module (الخصومات والعروض).
 *
 * One central promotions system managed from Admin and shared by:
 *   - POS / Cashier
 *   - Storefront / Website
 *   - Cart & Checkout
 *   - Sales & Orders
 *
 * Supports:
 *   - Offer Types: Standard Discount, Buy X Get Y (BXGY), Cheapest Item in Cart
 *   - Modes: Automatic (codeless) & Coupon (requires promo code)
 *   - Types: Percentage (%) & Fixed EGP amount & Free
 *   - Scopes: Entire store, Category, Product, Exact Variant (using exact variant UUID)
 *   - Channels: POS only, Storefront only, Both (default)
 *   - Scheduling: Starts At, Ends At, Always active
 *   - Statuses: Active, Scheduled, Paused, Expired
 *   - Overlapping rules: Best customer discount wins (no silent stacking)
 *   - Direct toggle of enabled/disabled state per promotion
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
import {
  getPromotionStatus,
  type Promotion,
  type PromotionChannel,
  type PromotionMode,
  type PromotionOfferType,
  type PromotionRewardType,
  type PromotionScope,
  type PromotionStatus,
  type PromotionTarget,
  type PromotionTargetDraft,
} from "../types";
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
  const [statusFilter, setStatusFilter] = useState<"all" | PromotionStatus>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [draft, setDraft] = useState<Promotion | null>(null);
  const [draftTargets, setDraftTargets] = useState<PromotionTargetDraft[]>([]);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
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
      mode: "automatic",
      code: null,
      channel: "both",
      name_en: "",
      name_ar: "",
      description_en: null,
      description_ar: null,
      offer_type: "standard",
      rule_type: "standard",
      discount_type: "percent",
      value: 10,
      scope: "store",
      minimum_order_amount: 0,
      maximum_discount_amount: null,
      starts_at: null,
      ends_at: null,
      priority: 0,
      stackable: false,
      buy_x: 2,
      get_y: 1,
      reward_type: "free",
      reward_value: 100,
      repeat_offer: true,
      min_quantity: 3,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    setDraftTargets([]);
    setValidationErrors({});
  };

  const openEdit = async (promotion: Promotion) => {
    const offerType = promotion.offer_type ?? promotion.rule_type ?? "standard";
    setDraft({
      ...promotion,
      mode: promotion.mode ?? "automatic",
      channel: promotion.channel ?? "both",
      offer_type: offerType,
      rule_type: offerType,
      buy_x: promotion.buy_x ?? 2,
      get_y: promotion.get_y ?? 1,
      reward_type: promotion.reward_type ?? "free",
      reward_value: promotion.reward_value ?? (promotion.reward_type === "percent" ? 50 : 100),
      repeat_offer: promotion.repeat_offer !== false,
      min_quantity: promotion.min_quantity ?? 3,
    });
    setValidationErrors({});
    try {
      const rows = await repository.listPromotionTargets(promotion.id);
      setDraftTargets(rows.map((row) => ({ target_kind: row.target_kind, target_id: row.target_id })));
    } catch {
      setDraftTargets([]);
    }
  };

  const validateDraft = (item: Promotion, currentTargets: PromotionTargetDraft[]): boolean => {
    const errors: Record<string, string> = {};
    if (!item.name_en.trim() || !item.name_ar.trim()) {
      errors.name = t("online.promos.validation.nameRequired");
    }
    if (item.mode === "coupon") {
      const trimmedCode = (item.code ?? "").trim();
      if (!trimmedCode || !/^[A-Z0-9_-]{2,30}$/i.test(trimmedCode)) {
        errors.code = t("online.promos.validation.codeRequired");
      }
    }
    const offerType = item.offer_type ?? item.rule_type ?? "standard";
    if (offerType === "standard") {
      if (item.discount_type === "percent") {
        if (item.value <= 0 || item.value > 100) {
          errors.value = t("online.promos.validation.percentRange");
        }
      } else if (item.value <= 0) {
        errors.value = t("online.promos.validation.fixedPositive");
      }
    } else if (offerType === "bxgy") {
      if (!item.buy_x || item.buy_x < 1) {
        errors.buy_x = "Buy quantity must be at least 1";
      }
      if (!item.get_y || item.get_y < 1) {
        errors.get_y = "Get quantity must be at least 1";
      }
      if (item.reward_type === "percent") {
        const rVal = item.reward_value ?? 100;
        if (rVal <= 0 || rVal > 100) {
          errors.reward_value = t("online.promos.validation.percentRange");
        }
      }
    } else if (offerType === "cheapest_item") {
      const minQ = item.min_quantity ?? item.buy_x ?? 1;
      if (minQ < 1) {
        errors.min_quantity = "Minimum quantity must be at least 1";
      }
      if (item.reward_type === "percent") {
        const rVal = item.reward_value ?? 100;
        if (rVal <= 0 || rVal > 100) {
          errors.reward_value = t("online.promos.validation.percentRange");
        }
      } else if (item.reward_type === "fixed") {
        const rVal = item.reward_value ?? 0;
        if (rVal <= 0) {
          errors.reward_value = t("online.promos.validation.fixedPositive");
        }
      }
    }
    if (item.starts_at && item.ends_at) {
      if (Date.parse(item.ends_at) < Date.parse(item.starts_at)) {
        errors.ends_at = t("online.promos.validation.dateOrder");
      }
    }
    if (item.scope !== "store" && currentTargets.length === 0) {
      errors.scope = t("online.promos.validation.targetsRequired");
    }
    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const save = async () => {
    if (!draft) return;
    if (!validateDraft(draft, draftTargets)) return;
    setBusy(true);
    try {
      const offerType = draft.offer_type ?? draft.rule_type ?? "standard";
      const payload: Promotion = {
        ...draft,
        offer_type: offerType,
        rule_type: offerType,
        code: draft.mode === "coupon" && draft.code ? draft.code.trim().toUpperCase() : null,
      };
      const saved = await repository.savePromotion(payload, draftTargets);
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

  const toggleEnabled = async (promotion: Promotion) => {
    setBusy(true);
    try {
      const updatedTargets = targets
        .filter((tRow) => tRow.promotion_id === promotion.id)
        .map((tRow) => ({ target_kind: tRow.target_kind, target_id: tRow.target_id }));
      const saved = await repository.savePromotion(
        { ...promotion, enabled: !promotion.enabled },
        updatedTargets,
      );
      setPromotions((current) => current.map((p) => (p.id === saved.id ? saved : p)));
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

  const filteredPromotions = useMemo(() => {
    const now = new Date();
    const query = searchQuery.trim().toLowerCase();
    return promotions.filter((promo) => {
      const status = getPromotionStatus(promo, now);
      if (statusFilter !== "all" && status !== statusFilter) return false;
      if (query) {
        const nameEn = promo.name_en.toLowerCase();
        const nameAr = promo.name_ar.toLowerCase();
        const code = (promo.code ?? "").toLowerCase();
        if (!nameEn.includes(query) && !nameAr.includes(query) && !code.includes(query)) {
          return false;
        }
      }
      return true;
    });
  }, [promotions, statusFilter, searchQuery]);

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
    <div className="space-y-6">
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

      {/* ── Status Tabs & Search Filter ──────────────────────────────────── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1 rounded-xl border border-stone-200 bg-stone-100 p-1">
          {(["all", "active", "scheduled", "paused", "expired"] as const).map((key) => {
            const active = statusFilter === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setStatusFilter(key)}
                data-testid={`promo-filter-${key}`}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                  active ? "bg-white text-stone-900 shadow-sm" : "text-stone-600 hover:text-stone-900"
                }`}
              >
                {t(`online.promos.filter.${key}`)}
              </button>
            );
          })}
        </div>

        <div className="w-full sm:w-72">
          <TextInput
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("online.promos.searchPlaceholder")}
            aria-label={t("online.promos.searchPlaceholder")}
            className="h-9 text-xs"
          />
        </div>
      </div>

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
      ) : filteredPromotions.length === 0 ? (
        <Card>
          <EmptyState
            icon="🏷️"
            title={t("online.promos.empty")}
            description={t("online.promos.emptyHint")}
          />
        </Card>
      ) : (
        <div className="alyq-card overflow-x-auto">
          <table className="w-full border-collapse text-sm" data-testid="promos-table">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50 text-[11px] font-bold uppercase tracking-wider text-stone-600">
                <th className="px-4 py-3 text-start font-semibold">{t("online.promos.colName")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("online.promos.channel")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("online.promos.colType")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("online.promos.colScope")}</th>
                <th className="px-3 py-3 text-end font-semibold">{t("online.promos.colValue")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("online.promos.colSchedule")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("online.promos.colStatus")}</th>
                <th className="px-3 py-3 text-center font-semibold">{t("online.promos.enabled")}</th>
                <th className="px-4 py-3 text-end font-semibold">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredPromotions.map((promotion) => {
                const status = getPromotionStatus(promotion);
                const statusVariant =
                  status === "active"
                    ? "success"
                    : status === "scheduled"
                      ? "info"
                      : status === "expired"
                        ? "danger"
                        : "neutral";
                const isCoupon = promotion.mode === "coupon";
                const offerType = promotion.offer_type ?? promotion.rule_type ?? "standard";

                return (
                  <tr
                    key={promotion.id}
                    data-testid={`promo-row-${promotion.id}`}
                    className="border-b border-stone-100 transition-colors last:border-0 hover:bg-stone-50/70"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-bold text-stone-900">
                          {pick(promotion.name_ar, promotion.name_en)}
                        </p>
                        {isCoupon ? (
                          <span className="rounded bg-indigo-50 px-1.5 py-0.5 font-mono text-[11px] font-bold text-indigo-700 ring-1 ring-inset ring-indigo-200">
                            {promotion.code}
                          </span>
                        ) : (
                          <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 ring-1 ring-inset ring-emerald-200">
                            {t("online.promos.mode.automatic")}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-stone-500">
                        {t(`online.promos.scope.${promotion.scope}`)}
                        {promotion.scope !== "store"
                          ? ` · ${t("online.promos.targetCount", { count: num(targetCount(promotion.id), 0) })}`
                          : ""}
                      </p>
                    </td>
                    <td className="px-3 py-3 text-xs font-semibold text-stone-700">
                      {promotion.channel === "pos"
                        ? t("online.promos.channel.pos")
                        : promotion.channel === "online" || promotion.channel === "storefront"
                          ? t("online.promos.channel.online")
                          : t("online.promos.channel.both")}
                    </td>
                    <td className="px-3 py-3 text-xs text-stone-700">
                      {offerType === "bxgy"
                        ? t("online.promos.offerType.bxgy")
                        : offerType === "cheapest_item"
                          ? t("online.promos.offerType.cheapestItem")
                          : promotion.discount_type === "percent"
                            ? t("online.promos.type.percent")
                            : t("online.promos.type.fixed")}
                    </td>
                    <td className="px-3 py-3 text-xs text-stone-700">
                      {t(`online.promos.scope.${promotion.scope}`)}
                    </td>
                    <td className="px-3 py-3 text-end text-sm font-bold tabular-nums text-stone-900">
                      {offerType === "bxgy" ? (
                        <span>
                          Buy {promotion.buy_x ?? 2} Get {promotion.get_y ?? 1}{" "}
                          {promotion.reward_type === "percent" ? `(${promotion.reward_value ?? 50}% off)` : "Free"}
                        </span>
                      ) : offerType === "cheapest_item" ? (
                        <span>
                          {promotion.reward_type === "free"
                            ? "Cheapest Free"
                            : promotion.reward_type === "percent"
                              ? `${promotion.reward_value ?? 50}% off cheapest`
                              : `${money(promotion.reward_value ?? 0)} off cheapest`}{" "}
                          (min {promotion.min_quantity ?? 3})
                        </span>
                      ) : promotion.discount_type === "percent" ? (
                        `${num(promotion.value, 0)}%`
                      ) : (
                        money(promotion.value)
                      )}
                      {promotion.maximum_discount_amount !== null
                        ? ` · max ${money(promotion.maximum_discount_amount)}`
                        : ""}
                    </td>
                    <td className="px-3 py-3 text-xs text-stone-600">
                      {promotion.starts_at || promotion.ends_at ? (
                        <div className="space-y-0.5 tabular-nums">
                          {promotion.starts_at ? (
                            <p>
                              <span className="font-semibold text-stone-500">{t("online.promos.startsAt")}:</span>{" "}
                              {date(promotion.starts_at)}
                            </p>
                          ) : null}
                          {promotion.ends_at ? (
                            <p>
                              <span className="font-semibold text-stone-500">{t("online.promos.endsAt")}:</span>{" "}
                              {date(promotion.ends_at)}
                            </p>
                          ) : (
                            <p className="text-stone-400">{t("online.promos.noEndDate")}</p>
                          )}
                        </div>
                      ) : (
                        <span className="text-stone-500">{t("online.promos.alwaysOn")}</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-xs">
                      <Badge tone={statusVariant}>
                        {t(`online.promos.status.${status}`)}
                      </Badge>
                    </td>
                    <td className="px-3 py-3 text-center">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={promotion.enabled}
                        disabled={busy}
                        onClick={() => void toggleEnabled(promotion)}
                        data-testid={`promo-toggle-${promotion.id}`}
                        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 ${
                          promotion.enabled ? "bg-indigo-600" : "bg-stone-300"
                        }`}
                      >
                        <span
                          className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                            promotion.enabled ? "translate-x-4 rtl:-translate-x-4" : "translate-x-0"
                          }`}
                        />
                      </button>
                    </td>
                    <td className="px-4 py-3 text-end">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void openEdit(promotion)}
                          data-testid={`promo-edit-${promotion.id}`}
                        >
                          {t("common.edit")}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => setConfirmDelete(promotion)}
                          data-testid={`promo-delete-${promotion.id}`}
                        >
                          {t("common.delete")}
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Create / Edit Promotion Modal ───────────────────────────────── */}
      <Modal
        open={draft !== null}
        title={draft?.id ? t("online.promos.edit") : t("online.promos.new")}
        onClose={() => {
          setDraft(null);
          setDraftTargets([]);
          setValidationErrors({});
        }}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setDraft(null);
                setDraftTargets([]);
                setValidationErrors({});
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button loading={busy} onClick={() => void save()} data-testid="promo-save">
              {t("common.save")}
            </Button>
          </>
        }
      >
        {draft ? (
          <div className="space-y-4 text-xs">
            {/* Names */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("online.promos.nameEn")} required>
                <TextInput
                  data-testid="promo-name-en"
                  value={draft.name_en}
                  invalid={Boolean(validationErrors.name)}
                  placeholder="e.g. Summer Sale / Buy 2 Get 1 Free"
                  onChange={(event) => setDraft({ ...draft, name_en: event.target.value })}
                />
              </Field>
              <Field label={t("online.promos.nameAr")} required>
                <TextInput
                  dir="rtl"
                  data-testid="promo-name-ar"
                  value={draft.name_ar}
                  invalid={Boolean(validationErrors.name)}
                  placeholder="مثال: تخفيضات الصيف / اشتري 2 واحصل على 1 مجانًا"
                  onChange={(event) => setDraft({ ...draft, name_ar: event.target.value })}
                />
              </Field>
            </div>
            {validationErrors.name ? (
              <p className="text-xs font-semibold text-rose-600">{validationErrors.name}</p>
            ) : null}

            {/* Offer Type Selection */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label={t("online.promos.offerType")}>
                <SelectInput
                  value={draft.offer_type ?? draft.rule_type ?? "standard"}
                  data-testid="promo-offer-type"
                  onChange={(event) => {
                    const offer_type = event.target.value as PromotionOfferType;
                    setDraft({ ...draft, offer_type, rule_type: offer_type });
                  }}
                >
                  <option value="standard">{t("online.promos.offerType.standard")}</option>
                  <option value="bxgy">{t("online.promos.offerType.bxgy")}</option>
                  <option value="cheapest_item">{t("online.promos.offerType.cheapestItem")}</option>
                </SelectInput>
              </Field>

              <Field label={t("online.promos.mode")}>
                <SelectInput
                  value={draft.mode ?? "automatic"}
                  data-testid="promo-mode"
                  onChange={(event) => {
                    const mode = event.target.value as PromotionMode;
                    setDraft({ ...draft, mode });
                  }}
                >
                  <option value="automatic">{t("online.promos.mode.automatic")}</option>
                  <option value="coupon">{t("online.promos.mode.coupon")}</option>
                </SelectInput>
              </Field>

              <Field label={t("online.promos.channel")}>
                <SelectInput
                  value={draft.channel ?? "both"}
                  data-testid="promo-channel"
                  onChange={(event) =>
                    setDraft({ ...draft, channel: event.target.value as PromotionChannel })
                  }
                >
                  <option value="both">{t("online.promos.channel.both")}</option>
                  <option value="pos">{t("online.promos.channel.pos")}</option>
                  <option value="online">{t("online.promos.channel.online")}</option>
                </SelectInput>
              </Field>
            </div>

            {/* Coupon Code (if mode === 'coupon') */}
            {draft.mode === "coupon" ? (
              <div>
                <Field label={t("online.promos.code")} hint={t("online.promos.codeHint")} required>
                  <TextInput
                    data-testid="promo-code"
                    value={draft.code ?? ""}
                    invalid={Boolean(validationErrors.code)}
                    placeholder="SUMMER20"
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        code: event.target.value.toUpperCase().replace(/\s+/g, ""),
                      })
                    }
                  />
                </Field>
                {validationErrors.code ? (
                  <p className="mt-1 text-xs font-semibold text-rose-600">{validationErrors.code}</p>
                ) : null}
              </div>
            ) : null}

            {/* Offer Type specific fields */}
            {(draft.offer_type ?? draft.rule_type ?? "standard") === "standard" ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={t("online.promos.type")}>
                  <SelectInput
                    value={draft.discount_type}
                    data-testid="promo-discount-type"
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        discount_type: event.target.value as Promotion["discount_type"],
                      })
                    }
                  >
                    <option value="percent">{t("online.promos.type.percent")}</option>
                    <option value="fixed">{t("online.promos.type.fixed")}</option>
                  </SelectInput>
                </Field>
                <Field label={t("online.promos.value")} required>
                  <TextInput
                    type="number"
                    min={0}
                    max={draft.discount_type === "percent" ? 100 : undefined}
                    step="0.01"
                    data-testid="promo-value"
                    value={String(draft.value)}
                    invalid={Boolean(validationErrors.value)}
                    onChange={(event) =>
                      setDraft({ ...draft, value: Math.max(0, Number(event.target.value) || 0) })
                    }
                  />
                </Field>
              </div>
            ) : (draft.offer_type ?? draft.rule_type) === "bxgy" ? (
              <div className="space-y-3 rounded-xl border border-indigo-100 bg-indigo-50/40 p-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label={t("online.promos.bxgy.buy")} hint={t("online.promos.bxgy.buyHint")} required>
                    <TextInput
                      type="number"
                      min={1}
                      step={1}
                      data-testid="promo-buy-x"
                      value={String(draft.buy_x ?? 2)}
                      onChange={(e) =>
                        setDraft({ ...draft, buy_x: Math.max(1, Math.trunc(Number(e.target.value) || 1)) })
                      }
                    />
                  </Field>
                  <Field label={t("online.promos.bxgy.get")} hint={t("online.promos.bxgy.getHint")} required>
                    <TextInput
                      type="number"
                      min={1}
                      step={1}
                      data-testid="promo-get-y"
                      value={String(draft.get_y ?? 1)}
                      onChange={(e) =>
                        setDraft({ ...draft, get_y: Math.max(1, Math.trunc(Number(e.target.value) || 1)) })
                      }
                    />
                  </Field>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label={t("online.promos.bxgy.reward")}>
                    <SelectInput
                      value={draft.reward_type ?? "free"}
                      data-testid="promo-reward-type"
                      onChange={(e) =>
                        setDraft({ ...draft, reward_type: e.target.value as PromotionRewardType })
                      }
                    >
                      <option value="free">{t("online.promos.bxgy.reward.free")}</option>
                      <option value="percent">{t("online.promos.bxgy.reward.percent")}</option>
                    </SelectInput>
                  </Field>

                  {draft.reward_type === "percent" ? (
                    <Field label={t("online.promos.bxgy.rewardPercent")} hint={t("online.promos.bxgy.rewardPercentHint")}>
                      <TextInput
                        type="number"
                        min={1}
                        max={100}
                        step="1"
                        value={String(draft.reward_value ?? 50)}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            reward_value: Math.min(100, Math.max(1, Number(e.target.value) || 0)),
                          })
                        }
                      />
                    </Field>
                  ) : (
                    <Field label={t("online.promos.bxgy.repeat")} hint={t("online.promos.bxgy.repeatHint")}>
                      <SelectInput
                        value={draft.repeat_offer !== false ? "yes" : "no"}
                        data-testid="promo-repeat-offer"
                        onChange={(e) =>
                          setDraft({ ...draft, repeat_offer: e.target.value === "yes" })
                        }
                      >
                        <option value="yes">{t("online.promos.bxgy.repeatYes")}</option>
                        <option value="no">{t("online.promos.bxgy.repeatNo")}</option>
                      </SelectInput>
                    </Field>
                  )}
                </div>

                {draft.reward_type === "percent" ? (
                  <Field label={t("online.promos.bxgy.repeat")} hint={t("online.promos.bxgy.repeatHint")}>
                    <SelectInput
                      value={draft.repeat_offer !== false ? "yes" : "no"}
                      onChange={(e) =>
                        setDraft({ ...draft, repeat_offer: e.target.value === "yes" })
                      }
                    >
                      <option value="yes">{t("online.promos.bxgy.repeatYes")}</option>
                      <option value="no">{t("online.promos.bxgy.repeatNo")}</option>
                    </SelectInput>
                  </Field>
                ) : null}
              </div>
            ) : (
              /* Cheapest Item Offer */
              <div className="space-y-3 rounded-xl border border-amber-100 bg-amber-50/40 p-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label={t("online.promos.cheapest.minQty")} hint={t("online.promos.cheapest.minQtyHint")} required>
                    <TextInput
                      type="number"
                      min={1}
                      step={1}
                      data-testid="promo-min-qty"
                      value={String(draft.min_quantity ?? 3)}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          min_quantity: Math.max(1, Math.trunc(Number(e.target.value) || 1)),
                          buy_x: Math.max(1, Math.trunc(Number(e.target.value) || 1)),
                        })
                      }
                    />
                  </Field>
                  <Field label={t("online.promos.cheapest.reward")}>
                    <SelectInput
                      value={draft.reward_type ?? "free"}
                      data-testid="promo-cheapest-reward"
                      onChange={(e) =>
                        setDraft({ ...draft, reward_type: e.target.value as PromotionRewardType })
                      }
                    >
                      <option value="free">{t("online.promos.cheapest.reward.free")}</option>
                      <option value="percent">{t("online.promos.cheapest.reward.percent")}</option>
                      <option value="fixed">{t("online.promos.cheapest.reward.fixed")}</option>
                    </SelectInput>
                  </Field>
                </div>

                {draft.reward_type !== "free" ? (
                  <Field label={t("online.promos.cheapest.value")} hint={t("online.promos.cheapest.valueHint")}>
                    <TextInput
                      type="number"
                      min={0}
                      max={draft.reward_type === "percent" ? 100 : undefined}
                      step="0.01"
                      value={String(draft.reward_value ?? (draft.reward_type === "percent" ? 50 : 20))}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          reward_value: Math.max(0, Number(e.target.value) || 0),
                          value: Math.max(0, Number(e.target.value) || 0),
                        })
                      }
                    />
                  </Field>
                ) : null}

                <Field label={t("online.promos.cheapest.repeat")} hint={t("online.promos.cheapest.repeatHint")}>
                  <SelectInput
                    value={draft.repeat_offer === true ? "yes" : "no"}
                    onChange={(e) =>
                      setDraft({ ...draft, repeat_offer: e.target.value === "yes" })
                    }
                  >
                    <option value="no">{t("online.promos.bxgy.repeatNo")}</option>
                    <option value="yes">{t("online.promos.bxgy.repeatYes")}</option>
                  </SelectInput>
                </Field>
              </div>
            )}

            {/* Scope & Priority */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("online.promos.scope")}>
                <SelectInput
                  value={draft.scope}
                  data-testid="promo-scope"
                  onChange={(event) => {
                    const scope = event.target.value as PromotionScope;
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
            </div>

            {/* Minimum Order & Maximum Discount */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("online.promos.minimum")} hint={t("online.promos.minimumHint")}>
                <TextInput
                  type="number"
                  min={0}
                  step="0.01"
                  value={String(draft.minimum_order_amount)}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      minimum_order_amount: Math.max(0, Number(event.target.value) || 0),
                    })
                  }
                />
              </Field>
              <Field label={t("online.promos.maximum")} hint={t("online.promos.maximumHint")}>
                <TextInput
                  type="number"
                  min={0}
                  step="0.01"
                  value={draft.maximum_discount_amount === null ? "" : String(draft.maximum_discount_amount)}
                  placeholder="Uncapped"
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      maximum_discount_amount:
                        event.target.value.trim() === ""
                          ? null
                          : Math.max(0, Number(event.target.value) || 0),
                    })
                  }
                />
              </Field>
            </div>

            {/* Scheduling */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("online.promos.startsAt")}>
                <TextInput
                  type="datetime-local"
                  data-testid="promo-starts-at"
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
                  data-testid="promo-ends-at"
                  value={toDateTimeLocal(draft.ends_at)}
                  invalid={Boolean(validationErrors.ends_at)}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      ends_at: event.target.value
                        ? fromDateTimeLocal(event.target.value, draft.starts_at ?? new Date().toISOString())
                        : null,
                    })
                  }
                />
              </Field>
            </div>
            {validationErrors.ends_at ? (
              <p className="text-xs font-semibold text-rose-600">{validationErrors.ends_at}</p>
            ) : null}

            {/* Toggles */}
            <div className="space-y-2 rounded-xl border border-stone-200 bg-stone-50/60 p-3">
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
            </div>

            {/* Target Picker */}
            {draft.scope !== "store" ? (
              <div>
                <ScopePicker
                  scope={draft.scope}
                  selected={draftTargets}
                  onChange={setDraftTargets}
                />
                {validationErrors.scope ? (
                  <p className="mt-1 text-xs font-semibold text-rose-600">{validationErrors.scope}</p>
                ) : null}
              </div>
            ) : (
              <div className="rounded-xl border border-stone-200 bg-stone-50 p-3 text-stone-600">
                <p className="font-semibold text-stone-800">{t("online.promos.scope.store")}</p>
                <p className="mt-0.5 text-[11px]">{t("online.promos.target.storewideHint")}</p>
              </div>
            )}
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={confirmDelete !== null}
        title={t("online.promos.deleteTitle")}
        body={t("online.promos.deleteBody", {
          label: confirmDelete ? pick(confirmDelete.name_ar, confirmDelete.name_en) : "",
        })}
        loading={busy}
        onConfirm={() => void remove()}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}

/**
 * Scope target picker: categories, products or exact variants, as exact UUID rows.
 * Relational targeting: no fabricated names or combination strings.
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
  const { t, pick, money } = useI18n();
  const { products, categories, variantsByProduct } = useCatalog();
  const [search, setSearch] = useState("");
  const [selectedProductId, setSelectedProductId] = useState<string>("");

  // When scope is variant, identify variant products
  const variantProducts = useMemo(() => {
    return products.filter((p) => p.active && p.variants_enabled);
  }, [products]);

  // If a target is already selected for variant scope, auto-focus its product if none selected
  useEffect(() => {
    if (scope === "variant" && !selectedProductId) {
      if (selected.length > 0) {
        const firstTargetId = selected[0].target_id;
        for (const [prodId, vList] of variantsByProduct.entries()) {
          if (vList.some((v) => v.id === firstTargetId)) {
            setSelectedProductId(prodId);
            break;
          }
        }
      } else if (variantProducts.length > 0) {
        setSelectedProductId(variantProducts[0].id);
      }
    }
  }, [scope, selected, selectedProductId, variantProducts, variantsByProduct]);

  // Options for Category / Product
  const categoryOptions = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return categories
      .filter((category) => category.active)
      .map((category) => ({
        id: category.id,
        labelEn: category.name_en,
        labelAr: category.name_ar,
        label: pick(category.name_ar, category.name_en),
        detail: "",
      }))
      .filter(
        (option) =>
          !needle ||
          option.labelEn.toLowerCase().includes(needle) ||
          option.labelAr.toLowerCase().includes(needle),
      );
  }, [categories, pick, search]);

  const productOptions = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return products
      .filter((product) => product.active)
      .map((product) => ({
        id: product.id,
        labelEn: product.name_en,
        labelAr: product.name_ar,
        label: pick(product.name_ar, product.name_en),
        detail: product.sku,
        price: product.selling_price,
      }))
      .filter(
        (option) =>
          !needle ||
          option.labelEn.toLowerCase().includes(needle) ||
          option.labelAr.toLowerCase().includes(needle) ||
          option.detail.toLowerCase().includes(needle),
      );
  }, [products, pick, search]);

  // Real active variants for selected product
  const activeProductVariants = useMemo(() => {
    if (!selectedProductId) return [];
    return (variantsByProduct.get(selectedProductId) ?? []).filter((v) => v.active);
  }, [selectedProductId, variantsByProduct]);

  const selectedVariantDetails = useMemo(() => {
    if (scope !== "variant") return [];
    const rows: { id: string; productName: string; variantName: string; sku: string }[] = [];
    for (const target of selected) {
      for (const product of variantProducts) {
        const vList = variantsByProduct.get(product.id) ?? [];
        const variant = vList.find((v) => v.id === target.target_id);
        if (variant) {
          const variantColor = pick(variant.color_ar, variant.color_en) ?? "";
          const variantSize = variant.size ?? variant.size_label ?? "";
          const descriptor = [variantColor, variantSize].filter(Boolean).join(" / ") || variant.sku;
          rows.push({
            id: variant.id,
            productName: pick(product.name_ar, product.name_en),
            variantName: descriptor,
            sku: variant.sku,
          });
          break;
        }
      }
    }
    return rows;
  }, [pick, scope, selected, variantProducts, variantsByProduct]);

  const toggleTarget = (id: string, kind: PromotionTarget["target_kind"]) => {
    if (selected.some((entry) => entry.target_id === id)) {
      onChange(selected.filter((entry) => entry.target_id !== id));
    } else {
      onChange([...selected, { target_kind: kind, target_id: id }]);
    }
  };

  const selectAllCategory = () => {
    const all = categoryOptions.map((opt) => ({ target_kind: "category" as const, target_id: opt.id }));
    onChange(all);
  };

  const selectAllProduct = () => {
    const all = productOptions.map((opt) => ({ target_kind: "product" as const, target_id: opt.id }));
    onChange(all);
  };

  const selectAllVariantsOfProduct = () => {
    const next = [...selected];
    for (const variant of activeProductVariants) {
      if (!next.some((entry) => entry.target_id === variant.id)) {
        next.push({ target_kind: "variant", target_id: variant.id });
      }
    }
    onChange(next);
  };

  return (
    <div className="rounded-xl border border-stone-200 bg-white p-3.5" data-testid="promo-target-picker">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-bold text-stone-900">
            {scope === "category"
              ? t("online.promos.target.categoryTitle")
              : scope === "product"
                ? t("online.promos.target.productTitle")
                : t("online.promos.target.variantTitle")}
          </p>
          <p className="mt-0.5 text-[11px] text-stone-500">
            {scope === "category"
              ? t("online.promos.target.categoryHint")
              : scope === "product"
                ? t("online.promos.target.productHint")
                : t("online.promos.target.variantHint")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-stone-100 px-2.5 py-0.5 font-mono text-[11px] font-bold text-stone-700">
            {t("online.promos.selectedCount", { count: selected.length })}
          </span>
          {selected.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => onChange([])}>
              {t("online.promos.target.clearAll")}
            </Button>
          ) : null}
        </div>
      </div>

      {/* ── 1. Category Target Picker ────────────────────────────────────── */}
      {scope === "category" && (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2">
            <TextInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("online.promos.target.searchCategories")}
              className="h-8 flex-1 text-xs"
            />
            {categoryOptions.length > 0 ? (
              <Button size="sm" variant="secondary" onClick={selectAllCategory}>
                {t("online.promos.target.selectAll")}
              </Button>
            ) : null}
          </div>
          <ul className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-stone-200 bg-stone-50/60 p-2">
            {categoryOptions.map((opt) => {
              const isChecked = selected.some((entry) => entry.target_id === opt.id);
              return (
                <li key={opt.id}>
                  <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors hover:bg-white">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleTarget(opt.id, "category")}
                      className="h-4 w-4 rounded border-stone-300 accent-indigo-600"
                    />
                    <span className="font-semibold text-stone-800">{opt.labelEn}</span>
                    <span className="font-semibold text-stone-500" dir="rtl">({opt.labelAr})</span>
                  </label>
                </li>
              );
            })}
            {categoryOptions.length === 0 && (
              <li className="px-2 py-4 text-center text-xs font-semibold text-stone-500">
                {t("online.marketing.noMatches")}
              </li>
            )}
          </ul>
        </div>
      )}

      {/* ── 2. Product Target Picker ─────────────────────────────────────── */}
      {scope === "product" && (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2">
            <TextInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("online.promos.target.searchProducts")}
              className="h-8 flex-1 text-xs"
            />
            {productOptions.length > 0 ? (
              <Button size="sm" variant="secondary" onClick={selectAllProduct}>
                {t("online.promos.target.selectAll")}
              </Button>
            ) : null}
          </div>
          <ul className="max-h-60 space-y-1 overflow-y-auto rounded-lg border border-stone-200 bg-stone-50/60 p-2">
            {productOptions.map((opt) => {
              const isChecked = selected.some((entry) => entry.target_id === opt.id);
              return (
                <li key={opt.id}>
                  <label className="flex cursor-pointer items-center justify-between gap-2.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors hover:bg-white">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleTarget(opt.id, "product")}
                        className="h-4 w-4 rounded border-stone-300 accent-indigo-600"
                      />
                      <div className="min-w-0">
                        <span className="font-semibold text-stone-900">{opt.labelEn}</span>
                        <span className="ms-1.5 text-stone-500" dir="rtl">({opt.labelAr})</span>
                        <span className="ms-2 font-mono text-[10px] text-stone-400">{opt.detail}</span>
                      </div>
                    </div>
                    <span className="shrink-0 font-bold tabular-nums text-stone-700">{money(opt.price)}</span>
                  </label>
                </li>
              );
            })}
            {productOptions.length === 0 && (
              <li className="px-2 py-4 text-center text-xs font-semibold text-stone-500">
                {t("online.marketing.noMatches")}
              </li>
            )}
          </ul>
        </div>
      )}

      {/* ── 3. Exact Variant Target Picker ───────────────────────────────── */}
      {scope === "variant" && (
        <div className="mt-3 space-y-3">
          <div>
            <label className="mb-1 block text-[11px] font-semibold text-stone-700">
              {t("online.promos.target.selectProductFirst")}
            </label>
            <SelectInput
              value={selectedProductId}
              data-testid="promo-variant-product-select"
              onChange={(e) => setSelectedProductId(e.target.value)}
            >
              {variantProducts.map((p) => (
                <option key={p.id} value={p.id}>
                  {pick(p.name_ar, p.name_en)} ({p.sku})
                </option>
              ))}
            </SelectInput>
          </div>

          {selectedProductId ? (
            <div className="space-y-1.5 rounded-lg border border-indigo-100 bg-indigo-50/30 p-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-stone-800">
                  {t("online.promos.target.allVariants")}
                </span>
                {activeProductVariants.length > 0 ? (
                  <Button size="sm" variant="secondary" onClick={selectAllVariantsOfProduct}>
                    {t("online.promos.target.selectAll")}
                  </Button>
                ) : null}
              </div>

              <ul className="max-h-48 space-y-1 overflow-y-auto">
                {activeProductVariants.map((variant) => {
                  const isChecked = selected.some((entry) => entry.target_id === variant.id);
                  const color = pick(variant.color_ar, variant.color_en);
                  const size = variant.size ?? variant.size_label ?? "";
                  const desc = [color, size].filter(Boolean).join(" / ") || variant.sku;
                  const price = variant.price_override;

                  return (
                    <li key={variant.id}>
                      <label className="flex cursor-pointer items-center justify-between gap-2.5 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs hover:border-indigo-300">
                        <div className="flex items-center gap-2.5">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleTarget(variant.id, "variant")}
                            className="h-4 w-4 rounded border-stone-300 accent-indigo-600"
                          />
                          <div>
                            <span className="font-bold text-stone-900">{desc}</span>
                            <span className="ms-2 font-mono text-[10px] text-stone-400">{variant.sku}</span>
                          </div>
                        </div>
                        {price !== null && price !== undefined ? (
                          <span className="font-bold tabular-nums text-stone-700">{money(price)}</span>
                        ) : null}
                      </label>
                    </li>
                  );
                })}
                {activeProductVariants.length === 0 && (
                  <li className="px-2 py-3 text-center text-xs text-stone-500">
                    {t("online.promos.target.noVariantsFound")}
                  </li>
                )}
              </ul>
            </div>
          ) : null}

          {/* Selected Variant Summary Badge List */}
          {selectedVariantDetails.length > 0 ? (
            <div className="space-y-1.5 rounded-lg border border-stone-200 bg-stone-50 p-2.5">
              <p className="text-[11px] font-bold text-stone-700">
                {t("online.promos.target.selectedVariants", { count: selectedVariantDetails.length })}
              </p>
              <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto">
                {selectedVariantDetails.map((item) => (
                  <span
                    key={item.id}
                    className="inline-flex items-center gap-1 rounded-md border border-stone-300 bg-white px-2 py-1 text-[11px] font-medium text-stone-800 shadow-xs"
                  >
                    <span>
                      {item.productName} · <strong className="text-stone-900">{item.variantName}</strong>
                    </span>
                    <button
                      type="button"
                      onClick={() => toggleTarget(item.id, "variant")}
                      className="ms-1 cursor-pointer font-bold text-stone-400 hover:text-rose-600"
                      aria-label="Remove"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
