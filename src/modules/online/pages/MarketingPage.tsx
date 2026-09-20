/**
 * Marketing — campaigns and coupons.
 *
 * Two different instruments, deliberately kept on one screen because a shop uses
 * them for the same job. A **campaign** is the shop deciding that these products
 * cost less until Sunday: it needs no code, it prices the catalogue itself, and
 * it is what puts a "Flash sale" badge on a product card. A **coupon** is a code
 * handed to particular customers: it applies at checkout, it can be capped, and
 * it can be limited to a product or a category.
 *
 * Neither one is trusted from the browser. The storefront shows campaign prices
 * and validates a coupon through `check_storefront_coupon`, but
 * `place_online_order` recomputes both server-side, so editing a campaign here
 * while somebody has a cart open changes what they pay, not what they can make
 * themselves pay.
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
  StatTile,
  TextInput,
  ToggleSwitch,
  useToast,
} from "@/components/ui";
import { getWebsiteRepository } from "../data";
import { toOnlineError, type OnlineErrorCode } from "../data/repository";
import type { CampaignDraft, CouponDraft } from "../data/repository";
import type { Campaign, Coupon, CouponTarget } from "../types";
import { fromDateTimeLocal, isWindowOpen, toDateTimeLocal } from "../services/datetime";
import { isCampaignLive, unitPriceOf } from "../services/pricing";

type Tab = "campaigns" | "coupons";

const inOneHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();
const inOneWeek = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

export function MarketingPage() {
  const { t, pick, num, money, date } = useI18n();
  const toast = useToast();
  const { user } = useAuth();
  const { products } = useCatalog();
  const repository = useMemo(() => getWebsiteRepository(), []);
  const canManage = canActAs(user, "manage_website");

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<OnlineErrorCode | null>(null);
  const [tab, setTab] = useState<Tab>("campaigns");
  const [busy, setBusy] = useState(false);

  const [campaignDraft, setCampaignDraft] = useState<Campaign | null>(null);
  const [couponDraft, setCouponDraft] = useState<Coupon | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ kind: Tab; id: string; label: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const snapshot = await repository.getMarketing();
      setCampaigns(snapshot.campaigns);
      setCoupons(snapshot.coupons);
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

  const liveCampaigns = useMemo(
    () => campaigns.filter((campaign) => isCampaignLive(campaign)),
    [campaigns],
  );
  const activeCoupons = useMemo(
    () => coupons.filter((coupon) => coupon.active && isWindowOpen(coupon.starts_at, coupon.ends_at)),
    [coupons],
  );
  const redemptions = useMemo(
    () => coupons.reduce((sum, coupon) => sum + coupon.used_count, 0),
    [coupons],
  );

  const saveCampaign = async () => {
    if (!campaignDraft) return;
    setBusy(true);
    try {
      const draft: CampaignDraft = { ...campaignDraft };
      if (!draft.id) delete draft.id;
      const saved = await repository.saveCampaign(draft);
      setCampaigns((current) => {
        const index = current.findIndex((entry) => entry.id === saved.id);
        if (index < 0) return [saved, ...current];
        const next = [...current];
        next[index] = saved;
        return next;
      });
      setCampaignDraft(null);
      toast.success(t("online.marketing.campaignSaved"));
    } catch (caught) {
      toast.error(t(`online.error.${toOnlineError(caught).code}`));
    } finally {
      setBusy(false);
    }
  };

  const saveCoupon = async () => {
    if (!couponDraft) return;
    setBusy(true);
    try {
      const draft: CouponDraft = { ...couponDraft, code: couponDraft.code.trim().toUpperCase() };
      if (!draft.id) delete draft.id;
      const saved = await repository.saveCoupon(draft);
      setCoupons((current) => {
        const index = current.findIndex((entry) => entry.id === saved.id);
        if (index < 0) return [saved, ...current];
        const next = [...current];
        next[index] = saved;
        return next;
      });
      setCouponDraft(null);
      toast.success(t("online.marketing.couponSaved"));
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
      if (confirmDelete.kind === "campaigns") {
        await repository.deleteCampaign(confirmDelete.id);
        setCampaigns((current) => current.filter((entry) => entry.id !== confirmDelete.id));
      } else {
        await repository.deleteCoupon(confirmDelete.id);
        setCoupons((current) => current.filter((entry) => entry.id !== confirmDelete.id));
      }
      toast.push(t("online.marketing.deleted"), "info");
      setConfirmDelete(null);
    } catch (caught) {
      toast.error(t(`online.error.${toOnlineError(caught).code}`));
    } finally {
      setBusy(false);
    }
  };

  if (!canManage) {
    return (
      <div>
        <PageHeader title={t("online.marketing.title")} subtitle={t("online.marketing.subtitle")} />
        <Card>
          <EmptyState icon="🔒" title={t("online.settings.noAccess")} description={t("online.settings.noAccessHint")} />
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={t("online.marketing.title")}
        crumbs={[{ label: t("home.breadcrumb.online"), to: "/online" }, { label: t("nav.marketing") }]}
        subtitle={t("online.marketing.subtitle")}
        actions={
          <>
            <Button variant="secondary" onClick={() => void load()} title={t("common.retry")}>
              ⟳
            </Button>
            <Button
              data-testid="coupon-new"
              onClick={() =>
                tab === "campaigns"
                  ? setCampaignDraft({
                      id: "",
                      name_ar: "",
                      name_en: "",
                      kind: "flash_sale",
                      discount_type: "percent",
                      discount_value: 10,
                      product_ids: [],
                      badge_ar: "",
                      badge_en: "",
                      starts_at: new Date().toISOString(),
                      ends_at: inOneWeek(),
                      active: true,
                      created_at: new Date().toISOString(),
                      updated_at: new Date().toISOString(),
                    })
                  : setCouponDraft({
                      id: "",
                      code: "",
                      title_en: "",
                      title_ar: "",
                      description_en: null,
                      description_ar: null,
                      discount_type: "percent",
                      value: 10,
                      min_subtotal: 0,
                      max_discount: null,
                      usage_limit: null,
                      used_count: 0,
                      per_customer_limit: null,
                      first_order_only: false,
                      stackable: false,
                      applies_to: "all",
                      target_ids: [],
                      active: true,
                      starts_at: null,
                      ends_at: null,
                      created_at: new Date().toISOString(),
                      updated_at: new Date().toISOString(),
                    })
              }
            >
              {tab === "campaigns" ? t("online.marketing.newCampaign") : t("online.marketing.newCoupon")}
            </Button>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatTile label={t("online.marketing.liveNow")} value={num(liveCampaigns.length, 0)} tone="success" />
        <StatTile
          label={t("online.marketing.allCampaigns")}
          value={num(campaigns.length, 0)}
          tone="primary"
          hint={t("online.marketing.scheduledHint", {
            count: num(campaigns.length - liveCampaigns.length, 0),
          })}
        />
        <StatTile label={t("online.marketing.activeCoupons")} value={num(activeCoupons.length, 0)} tone="info" />
        <StatTile label={t("online.marketing.redemptions")} value={num(redemptions, 0)} tone="warning" />
      </div>

      <Card className="mb-4">
        <div className="flex rounded-xl bg-slate-100 p-1">
          {(["campaigns", "coupons"] as Tab[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`flex-1 rounded-lg px-4 py-1.5 text-xs font-bold transition-all ${
                tab === key ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {key === "campaigns"
                ? `${t("online.marketing.tabCampaigns")} (${campaigns.length})`
                : `${t("online.marketing.tabCoupons")} (${coupons.length})`}
            </button>
          ))}
        </div>
      </Card>

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
      ) : tab === "campaigns" ? (
        campaigns.length === 0 ? (
          <Card>
            <EmptyState icon="🏷️" title={t("online.marketing.noCampaigns")} description={t("online.marketing.noCampaignsHint")} />
          </Card>
        ) : (
          <div className="space-y-3">
            {campaigns.map((campaign) => {
              const live = isCampaignLive(campaign);
              const affected = products.filter((product) => campaign.product_ids.includes(product.id));
              const sample = affected[0];
              // What this campaign does to one product's price — computed the same
              // way checkout computes it, including a campaign that is only
              // scheduled (so the operator sees the number before it goes live).
              const samplePrice = sample ? unitPriceOf(sample.selling_price, campaign) : null;
              return (
                <Card key={campaign.id} className="space-y-2">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-slate-900">
                        {pick(campaign.name_ar, campaign.name_en)}
                        <Badge tone={campaign.kind === "flash_sale" ? "warning" : "info"}>
                          {t(`online.campaignKind.${campaign.kind}`)}
                        </Badge>
                        <Badge tone={live ? "success" : campaign.active ? "neutral" : "danger"}>
                          {live
                            ? t("online.marketing.live")
                            : campaign.active
                              ? t("online.marketing.scheduled")
                              : t("online.marketing.inactive")}
                        </Badge>
                      </p>
                      <p className="mt-1 text-xs text-slate-600">
                        {campaign.discount_type === "percent"
                          ? t("online.marketing.percentOff", { value: num(campaign.discount_value, 0) })
                          : t("online.marketing.fixedOff", { value: money(campaign.discount_value) })}
                        {" · "}
                        {date(campaign.starts_at)} → {date(campaign.ends_at)}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {t("online.marketing.productCount", { count: num(campaign.product_ids.length, 0) })}
                        {sample && samplePrice !== null && samplePrice < sample.selling_price
                          ? ` · ${t("online.marketing.examplePrice", {
                              name: pick(sample.name_ar, sample.name_en),
                              price: money(samplePrice),
                            })}`
                          : ""}
                        {pick(campaign.badge_ar, campaign.badge_en)
                          ? ` · ${t("online.marketing.badge")}: ${pick(campaign.badge_ar, campaign.badge_en)}`
                          : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button size="sm" variant="secondary" onClick={() => setCampaignDraft(campaign)}>
                        {t("common.edit")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setConfirmDelete({
                            kind: "campaigns",
                            id: campaign.id,
                            label: pick(campaign.name_ar, campaign.name_en),
                          })
                        }
                      >
                        {t("common.delete")}
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )
      ) : coupons.length === 0 ? (
        <Card>
          <EmptyState icon="🎟️" title={t("online.marketing.noCoupons")} description={t("online.marketing.noCouponsHint")} />
        </Card>
      ) : (
        <div className="space-y-3">
          {coupons.map((coupon) => {
            const usable = coupon.active && isWindowOpen(coupon.starts_at, coupon.ends_at);
            const exhausted =
              coupon.usage_limit !== null && coupon.used_count >= coupon.usage_limit;
            return (
              <Card key={coupon.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-slate-900">
                      <span className="font-mono" dir="ltr">
                        {coupon.code}
                      </span>
                      <Badge tone={usable && !exhausted ? "success" : exhausted ? "warning" : "danger"}>
                        {!coupon.active
                          ? t("online.marketing.inactive")
                          : exhausted
                            ? t("online.marketing.exhausted")
                            : usable
                              ? t("online.marketing.usable")
                              : t("online.marketing.outsideWindow")}
                      </Badge>
                    </p>
                    <p className="mt-1 text-xs text-slate-600">
                      {coupon.discount_type === "percent"
                        ? t("online.marketing.percentOff", { value: num(coupon.value, 0) })
                        : coupon.discount_type === "free_shipping"
                          ? t("online.marketing.freeShipping")
                          : t("online.marketing.fixedOff", { value: money(coupon.value) })}
                      {coupon.max_discount !== null
                        ? ` · ${t("online.marketing.cappedAt", { value: money(coupon.max_discount) })}`
                        : ""}
                      {coupon.min_subtotal > 0
                        ? ` · ${t("online.marketing.minSubtotal", { value: money(coupon.min_subtotal) })}`
                        : ""}
                      {coupon.first_order_only ? ` · ${t("online.marketing.firstOrderOnly")}` : ""}
                      {coupon.stackable ? ` · ${t("online.marketing.stackable")}` : ""}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {t("online.marketing.used", {
                        count: num(coupon.used_count, 0),
                        limit: coupon.usage_limit === null ? t("online.marketing.unlimited") : num(coupon.usage_limit, 0),
                      })}
                      {coupon.per_customer_limit !== null
                        ? ` · ${t("online.marketing.perCustomerUsed", { count: num(coupon.per_customer_limit, 0) })}`
                        : ""}
                      {" · "}
                      {coupon.applies_to === "all"
                        ? t("online.marketing.appliesAll")
                        : coupon.applies_to === "products"
                          ? t("online.marketing.appliesProducts", { count: num(coupon.target_ids.length, 0) })
                          : t("online.marketing.appliesCategories", { count: num(coupon.target_ids.length, 0) })}
                      {coupon.starts_at || coupon.ends_at
                        ? ` · ${coupon.starts_at ? date(coupon.starts_at) : "—"} → ${coupon.ends_at ? date(coupon.ends_at) : "—"}`
                        : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setCouponDraft(coupon)}>
                      {t("common.edit")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmDelete({ kind: "coupons", id: coupon.id, label: coupon.code })}
                    >
                      {t("common.delete")}
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* campaign editor */}
      <Modal
        open={campaignDraft !== null}
        onClose={() => setCampaignDraft(null)}
        size="lg"
        title={campaignDraft?.id ? t("online.marketing.editCampaign") : t("online.marketing.newCampaign")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCampaignDraft(null)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => void saveCampaign()}
              loading={busy}
              disabled={
                !campaignDraft ||
                (!campaignDraft.name_ar.trim() && !campaignDraft.name_en.trim()) ||
                campaignDraft.product_ids.length === 0 ||
                campaignDraft.discount_value <= 0 ||
                Date.parse(campaignDraft.ends_at) <= Date.parse(campaignDraft.starts_at)
              }
            >
              {t("common.save")}
            </Button>
          </>
        }
      >
        {campaignDraft ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("online.marketing.nameAr")} required>
                <TextInput
                  dir="rtl"
                  value={campaignDraft.name_ar}
                  onChange={(event) => setCampaignDraft({ ...campaignDraft, name_ar: event.target.value })}
                />
              </Field>
              <Field label={t("online.marketing.nameEn")} required>
                <TextInput
                  dir="ltr"
                  value={campaignDraft.name_en}
                  onChange={(event) => setCampaignDraft({ ...campaignDraft, name_en: event.target.value })}
                />
              </Field>
              <Field label={t("online.marketing.kind")}>
                <SelectInput
                  value={campaignDraft.kind}
                  onChange={(event) =>
                    setCampaignDraft({ ...campaignDraft, kind: event.target.value as Campaign["kind"] })
                  }
                >
                  <option value="flash_sale">{t("online.campaignKind.flash_sale")}</option>
                  <option value="promotion">{t("online.campaignKind.promotion")}</option>
                </SelectInput>
              </Field>
              <Field label={t("online.marketing.discountType")}>
                <SelectInput
                  value={campaignDraft.discount_type}
                  onChange={(event) =>
                    setCampaignDraft({
                      ...campaignDraft,
                      discount_type: event.target.value as Campaign["discount_type"],
                    })
                  }
                >
                  <option value="percent">{t("online.marketing.percent")}</option>
                  <option value="fixed">{t("online.marketing.fixed")}</option>
                </SelectInput>
              </Field>
              <Field
                label={
                  campaignDraft.discount_type === "percent"
                    ? t("online.marketing.percentValue")
                    : t("online.marketing.fixedValue")
                }
              >
                <TextInput
                  type="number"
                  min={0}
                  step="0.01"
                  value={String(campaignDraft.discount_value)}
                  onChange={(event) =>
                    setCampaignDraft({
                      ...campaignDraft,
                      discount_value: Math.max(0, Number(event.target.value) || 0),
                    })
                  }
                />
              </Field>
              <Field label={t("online.marketing.startsAt")} required>
                <TextInput
                  type="datetime-local"
                  value={toDateTimeLocal(campaignDraft.starts_at)}
                  onChange={(event) =>
                    setCampaignDraft({
                      ...campaignDraft,
                      starts_at: fromDateTimeLocal(event.target.value, campaignDraft.starts_at),
                    })
                  }
                />
              </Field>
              <Field label={t("online.marketing.endsAt")} required>
                <TextInput
                  type="datetime-local"
                  value={toDateTimeLocal(campaignDraft.ends_at)}
                  onChange={(event) =>
                    setCampaignDraft({
                      ...campaignDraft,
                      ends_at: fromDateTimeLocal(event.target.value, inOneHour()),
                    })
                  }
                />
              </Field>
              <Field label={t("online.marketing.badgeAr")} hint={t("online.marketing.badgeHint")}>
                <TextInput
                  dir="rtl"
                  value={campaignDraft.badge_ar ?? ""}
                  onChange={(event) => setCampaignDraft({ ...campaignDraft, badge_ar: event.target.value })}
                />
              </Field>
              <Field label={t("online.marketing.badgeEn")}>
                <TextInput
                  dir="ltr"
                  value={campaignDraft.badge_en ?? ""}
                  onChange={(event) => setCampaignDraft({ ...campaignDraft, badge_en: event.target.value })}
                />
              </Field>
            </div>

            <ToggleSwitch
              checked={campaignDraft.active}
              onChange={(checked) => setCampaignDraft({ ...campaignDraft, active: checked })}
              label={t("online.marketing.active")}
              hint={t("online.marketing.activeHint")}
            />

            <TargetPicker
              kind="products"
              title={t("online.marketing.chooseProducts")}
              hint={t("online.marketing.chooseProductsHint")}
              selected={campaignDraft.product_ids}
              onChange={(ids) => setCampaignDraft({ ...campaignDraft, product_ids: ids })}
            />
          </div>
        ) : null}
      </Modal>

      {/* coupon editor */}
      <Modal
        open={couponDraft !== null}
        onClose={() => setCouponDraft(null)}
        size="lg"
        title={couponDraft?.id ? t("online.marketing.editCoupon") : t("online.marketing.newCoupon")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCouponDraft(null)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button
              data-testid="coupon-save"
              onClick={() => void saveCoupon()}
              loading={busy}
              disabled={
                !couponDraft ||
                couponDraft.code.trim().length < 3 ||
                couponDraft.value <= 0 ||
                (couponDraft.ends_at !== null &&
                  couponDraft.starts_at !== null &&
                  Date.parse(couponDraft.ends_at) <= Date.parse(couponDraft.starts_at))
              }
            >
              {t("common.save")}
            </Button>
          </>
        }
      >
        {couponDraft ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("online.marketing.code")} required hint={t("online.marketing.codeHint")}>
                <TextInput
                  dir="ltr"
                  data-testid="coupon-code"
                  value={couponDraft.code}
                  onChange={(event) =>
                    setCouponDraft({ ...couponDraft, code: event.target.value.toUpperCase() })
                  }
                  className="font-mono uppercase"
                />
              </Field>
              <Field label={t("online.marketing.discountType")}>
                <SelectInput
                  value={couponDraft.discount_type}
                  onChange={(event) =>
                    setCouponDraft({
                      ...couponDraft,
                      discount_type: event.target.value as Coupon["discount_type"],
                    })
                  }
                >
                  <option value="percent">{t("online.marketing.percent")}</option>
                  <option value="fixed">{t("online.marketing.fixed")}</option>
                  <option value="free_shipping">{t("online.marketing.freeShipping")}</option>
                </SelectInput>
              </Field>
              <Field
                label={t("online.marketing.couponTitleEn")}
                hint={t("online.marketing.couponTitleHint")}
              >
                <TextInput
                  dir="ltr"
                  value={couponDraft.title_en}
                  onChange={(event) => setCouponDraft({ ...couponDraft, title_en: event.target.value })}
                />
              </Field>
              <Field label={t("online.marketing.couponTitleAr")}>
                <TextInput
                  dir="rtl"
                  value={couponDraft.title_ar}
                  onChange={(event) => setCouponDraft({ ...couponDraft, title_ar: event.target.value })}
                />
              </Field>
              <Field
                label={t("online.marketing.value")}
                hint={
                  couponDraft.discount_type === "free_shipping"
                    ? t("online.marketing.freeShippingValueHint")
                    : undefined
                }
              >
                <TextInput
                  type="number"
                  min={0}
                  step="0.01"
                  data-testid="coupon-value"
                  disabled={couponDraft.discount_type === "free_shipping"}
                  value={String(couponDraft.value)}
                  onChange={(event) =>
                    setCouponDraft({ ...couponDraft, value: Math.max(0, Number(event.target.value) || 0) })
                  }
                />
              </Field>
              <Field
                label={t("online.marketing.maxDiscount")}
                hint={t("online.marketing.maxDiscountHint")}
              >
                <TextInput
                  type="number"
                  min={0}
                  step="0.01"
                  data-testid="coupon-max"
                  disabled={couponDraft.discount_type !== "percent"}
                  value={couponDraft.max_discount === null ? "" : String(couponDraft.max_discount)}
                  placeholder={t("online.marketing.uncapped")}
                  onChange={(event) =>
                    setCouponDraft({
                      ...couponDraft,
                      max_discount:
                        event.target.value.trim() === "" ? null : Math.max(0, Number(event.target.value) || 0),
                    })
                  }
                />
              </Field>
              <Field label={t("online.marketing.minSubtotalLabel")}>
                <TextInput
                  type="number"
                  min={0}
                  step="0.01"
                  data-testid="coupon-min"
                  value={String(couponDraft.min_subtotal)}
                  onChange={(event) =>
                    setCouponDraft({
                      ...couponDraft,
                      min_subtotal: Math.max(0, Number(event.target.value) || 0),
                    })
                  }
                />
              </Field>
              <Field label={t("online.marketing.usageLimit")} hint={t("online.marketing.usageLimitHint")}>
                <TextInput
                  type="number"
                  min={1}
                  value={couponDraft.usage_limit === null ? "" : String(couponDraft.usage_limit)}
                  placeholder={t("online.marketing.unlimited")}
                  onChange={(event) =>
                    setCouponDraft({
                      ...couponDraft,
                      usage_limit:
                        event.target.value.trim() === "" ? null : Math.max(1, Number(event.target.value) || 1),
                    })
                  }
                />
              </Field>
              <Field
                label={t("online.marketing.perCustomerLimit")}
                hint={t("online.marketing.perCustomerLimitHint")}
              >
                <TextInput
                  type="number"
                  min={1}
                  value={couponDraft.per_customer_limit === null ? "" : String(couponDraft.per_customer_limit)}
                  placeholder={t("online.marketing.unlimited")}
                  onChange={(event) =>
                    setCouponDraft({
                      ...couponDraft,
                      per_customer_limit:
                        event.target.value.trim() === "" ? null : Math.max(1, Number(event.target.value) || 1),
                    })
                  }
                />
              </Field>
              <Field label={t("online.marketing.startsAt")} hint={t("online.marketing.optionalWindow")}>
                <TextInput
                  type="datetime-local"
                  value={toDateTimeLocal(couponDraft.starts_at)}
                  onChange={(event) =>
                    setCouponDraft({
                      ...couponDraft,
                      starts_at: event.target.value
                        ? fromDateTimeLocal(event.target.value, new Date().toISOString())
                        : null,
                    })
                  }
                />
              </Field>
              <Field label={t("online.marketing.endsAt")}>
                <TextInput
                  type="datetime-local"
                  value={toDateTimeLocal(couponDraft.ends_at)}
                  onChange={(event) =>
                    setCouponDraft({
                      ...couponDraft,
                      ends_at: event.target.value ? fromDateTimeLocal(event.target.value, inOneWeek()) : null,
                    })
                  }
                />
              </Field>
              <Field label={t("online.marketing.appliesTo")}>
                <SelectInput
                  value={couponDraft.applies_to}
                  onChange={(event) =>
                    setCouponDraft({
                      ...couponDraft,
                      applies_to: event.target.value as CouponTarget,
                      target_ids: event.target.value === "all" ? [] : couponDraft.target_ids,
                    })
                  }
                >
                  <option value="all">{t("online.marketing.appliesAll")}</option>
                  <option value="products">{t("online.marketing.appliesToProducts")}</option>
                  <option value="categories">{t("online.marketing.appliesToCategories")}</option>
                </SelectInput>
              </Field>
            </div>

            <ToggleSwitch
              checked={couponDraft.active}
              onChange={(checked) => setCouponDraft({ ...couponDraft, active: checked })}
              label={t("online.marketing.active")}
              hint={t("online.marketing.couponActiveHint")}
            />

            <ToggleSwitch
              checked={couponDraft.first_order_only}
              onChange={(checked) => setCouponDraft({ ...couponDraft, first_order_only: checked })}
              label={t("online.marketing.firstOrderOnly")}
              hint={t("online.marketing.firstOrderOnlyHint")}
            />

            <ToggleSwitch
              checked={couponDraft.stackable}
              onChange={(checked) => setCouponDraft({ ...couponDraft, stackable: checked })}
              label={t("online.marketing.stackable")}
              hint={t("online.marketing.stackableHint")}
            />

            {couponDraft.applies_to !== "all" ? (
              <TargetPicker
                kind={couponDraft.applies_to === "products" ? "products" : "categories"}
                title={
                  couponDraft.applies_to === "products"
                    ? t("online.marketing.chooseProducts")
                    : t("online.marketing.chooseCategories")
                }
                hint={t("online.marketing.chooseTargetsHint")}
                selected={couponDraft.target_ids}
                onChange={(ids) => setCouponDraft({ ...couponDraft, target_ids: ids })}
              />
            ) : null}

            {couponDraft.id ? (
              <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600">
                {t("online.marketing.usedSoFar", { count: num(couponDraft.used_count, 0) })}
              </p>
            ) : null}
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={confirmDelete !== null}
        title={confirmDelete?.kind === "campaigns" ? t("online.marketing.deleteCampaign") : t("online.marketing.deleteCoupon")}
        body={t("online.marketing.deleteBody", { label: confirmDelete?.label ?? "" })}
        loading={busy}
        onConfirm={() => void remove()}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}

/**
 * Product/category multi-select.
 *
 * A plain `<select multiple>` is unusable with a catalogue of any size, so this
 * is a searchable checklist. It writes ids only — names stay in the catalogue,
 * where a rename does not leave a stale copy behind.
 */
function TargetPicker({
  kind,
  title,
  hint,
  selected,
  onChange,
}: {
  kind: "products" | "categories";
  title: string;
  hint?: string;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const { t, pick } = useI18n();
  const { products, categories } = useCatalog();
  const [search, setSearch] = useState("");

  const options = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (kind === "categories") {
      return categories
        .map((category) => ({
          id: category.id,
          label: pick(category.name_ar, category.name_en),
          detail: "",
        }))
        .filter((option) => !needle || option.label.toLowerCase().includes(needle));
    }
    return products
      .map((product) => ({
        id: product.id,
        label: pick(product.name_ar, product.name_en),
        detail: product.sku,
      }))
      .filter(
        (option) =>
          !needle ||
          option.label.toLowerCase().includes(needle) ||
          option.detail.toLowerCase().includes(needle),
      );
  }, [categories, kind, pick, products, search]);

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id]);

  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <p className="text-xs font-bold text-slate-800">{title}</p>
      {hint ? <p className="mt-0.5 text-[11px] font-medium text-slate-500">{hint}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <TextInput
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("common.search")}
          className="h-9 flex-1 text-xs"
          aria-label={t("common.search")}
        />
        <span className="text-xs font-bold text-slate-600">
          {t("online.marketing.selectedCount", { count: selected.length })}
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
                checked={selected.includes(option.id)}
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
        {options.length > 200 ? (
          <li className="px-2 py-2 text-center text-[11px] font-semibold text-slate-500">
            {t("online.marketing.narrowSearch", { count: options.length })}
          </li>
        ) : null}
      </ul>
    </div>
  );
}
