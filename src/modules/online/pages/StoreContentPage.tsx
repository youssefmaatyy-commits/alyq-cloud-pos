/**
 * Website content — what the catalogue does not carry.
 *
 * A product row in this app belongs to the till: it has a price, a cost, a stock
 * quantity and an Excel import that must keep working exactly as it does today.
 * The website needs more than that — a brand, a URL slug, a search title, a spec
 * table — and none of it belongs in `products`. So it lives here, in
 * `product_content`, one row per product, written from this screen.
 *
 * The same screen owns the homepage's FAQ and the reviews, because they are the
 * same kind of thing: text a shopper reads and an employee writes, with no
 * effect on stock or money.
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
  SearchIcon,
  SelectInput,
  StatTile,
  TextArea,
  TextInput,
  ToggleSwitch,
  useToast,
} from "@/components/ui";
import { getWebsiteRepository } from "../data";
import { toOnlineError, type OnlineErrorCode } from "../data/repository";
import type {
  FaqDraft,
  ProductContentDraft,
  ReviewDraft,
} from "../data/repository";
import type { Product } from "@/modules/products/types";
import type { ProductContent, ProductContentMediaItem, ProductSpec, StoreFaq, StoreReview } from "../types";
import { slugifyAscii } from "../services/seo";
import { MediaListEditor } from "../components/admin/website/WebsiteTabPanels";

type Tab = "products" | "faqs" | "reviews";

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const emptySpec = (): ProductSpec => ({
  id: newId(),
  label_ar: "",
  label_en: "",
  value_ar: "",
  value_en: "",
});

/** The slug the database will accept: lowercase ASCII, dashes, no empties. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function StoreContentPage() {
  const { t, pick, num } = useI18n();
  const toast = useToast();
  const { user } = useAuth();
  const { products } = useCatalog();
  const repository = useMemo(() => getWebsiteRepository(), []);
  const canManage = canActAs(user, "manage_website");

  const [contents, setContents] = useState<ProductContent[]>([]);
  const [faqs, setFaqs] = useState<StoreFaq[]>([]);
  const [reviews, setReviews] = useState<StoreReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<OnlineErrorCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("products");
  const [search, setSearch] = useState("");

  const [contentDraft, setContentDraft] = useState<{ product: Product; content: ProductContent } | null>(null);
  const [faqDraft, setFaqDraft] = useState<StoreFaq | null>(null);
  const [reviewDraft, setReviewDraft] = useState<StoreReview | null>(null);
  const [confirm, setConfirm] = useState<{ kind: Tab; id: string; label: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [contentList, faqList, reviewList] = await Promise.all([
        repository.listProductContents(),
        repository.listFaqs(),
        repository.listReviews(),
      ]);
      setContents(contentList);
      setFaqs(faqList);
      setReviews(reviewList);
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

  const contentByProduct = useMemo(
    () => new Map(contents.map((content) => [content.product_id, content])),
    [contents],
  );

  const filteredProducts = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = products.filter((product) => product.show_on_website || contentByProduct.has(product.id));
    if (!needle) return list;
    return list.filter((product) => {
      const content = contentByProduct.get(product.id);
      return (
        pick(product.name_ar, product.name_en).toLowerCase().includes(needle) ||
        product.sku.toLowerCase().includes(needle) ||
        (content?.slug ?? "").toLowerCase().includes(needle) ||
        (content?.brand_en ?? "").toLowerCase().includes(needle) ||
        (content?.brand_ar ?? "").includes(search.trim())
      );
    });
  }, [contentByProduct, pick, products, search]);

  const draftContent = (product: Product): ProductContent =>
    contentByProduct.get(product.id) ?? {
      product_id: product.id,
      brand_ar: null,
      brand_en: null,
      slug: slugifyAscii(product.name_en || product.name_ar, product.sku),
      seo_title: null,
      seo_description: null,
      specs: [],
      media: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

  const saveContent = async () => {
    if (!contentDraft) return;
    const slug = (contentDraft.content.slug ?? "").trim().toLowerCase();
    if (slug && !SLUG_PATTERN.test(slug)) {
      toast.error(t("online.content.slugInvalid"));
      return;
    }
    setBusy(true);
    try {
      const draft: ProductContentDraft = {
        product_id: contentDraft.product.id,
        brand_ar: contentDraft.content.brand_ar?.trim() || null,
        brand_en: contentDraft.content.brand_en?.trim() || null,
        slug: slug || null,
        seo_title: contentDraft.content.seo_title?.trim() || null,
        seo_description: contentDraft.content.seo_description?.trim() || null,
        // Phase 45 editorial fields: trimmed to null when empty, so an old
        // row's values are replaced rather than merged with stale text.
        short_description_ar: contentDraft.content.short_description_ar?.trim() || null,
        short_description_en: contentDraft.content.short_description_en?.trim() || null,
        description_ar: contentDraft.content.description_ar?.trim() || null,
        description_en: contentDraft.content.description_en?.trim() || null,
        materials_ar: contentDraft.content.materials_ar?.trim() || null,
        materials_en: contentDraft.content.materials_en?.trim() || null,
        dimensions_ar: contentDraft.content.dimensions_ar?.trim() || null,
        dimensions_en: contentDraft.content.dimensions_en?.trim() || null,
        care_ar: contentDraft.content.care_ar?.trim() || null,
        care_en: contentDraft.content.care_en?.trim() || null,
        shipping_ar: contentDraft.content.shipping_ar?.trim() || null,
        shipping_en: contentDraft.content.shipping_en?.trim() || null,
        returns_ar: contentDraft.content.returns_ar?.trim() || null,
        returns_en: contentDraft.content.returns_en?.trim() || null,
        gift_note_ar: contentDraft.content.gift_note_ar?.trim() || null,
        gift_note_en: contentDraft.content.gift_note_en?.trim() || null,
        media: contentDraft.content.media ?? [],
        // A spec with no label and no value in either language is noise.
        specs: contentDraft.content.specs.filter(
          (spec) =>
            spec.label_ar.trim() || spec.label_en.trim() || spec.value_ar.trim() || spec.value_en.trim(),
        ),
      };
      const saved = await repository.saveProductContent(draft);
      setContents((current) => {
        const index = current.findIndex((entry) => entry.product_id === saved.product_id);
        if (index < 0) return [...current, saved];
        const next = [...current];
        next[index] = saved;
        return next;
      });
      setContentDraft(null);
      toast.success(t("online.content.contentSaved"));
    } catch (caught) {
      toast.error(t(`online.error.${toOnlineError(caught).code}`));
    } finally {
      setBusy(false);
    }
  };

  const saveFaq = async () => {
    if (!faqDraft) return;
    setBusy(true);
    try {
      const draft: FaqDraft = { ...faqDraft };
      if (!draft.id) delete draft.id;
      const saved = await repository.saveFaq(draft);
      setFaqs((current) => {
        const index = current.findIndex((entry) => entry.id === saved.id);
        if (index < 0) return [...current, saved];
        const next = [...current];
        next[index] = saved;
        return next;
      });
      setFaqDraft(null);
      toast.success(t("online.content.faqSaved"));
    } catch (caught) {
      toast.error(t(`online.error.${toOnlineError(caught).code}`));
    } finally {
      setBusy(false);
    }
  };

  const saveReview = async () => {
    if (!reviewDraft) return;
    setBusy(true);
    try {
      const draft: ReviewDraft = { ...reviewDraft };
      if (!draft.id) delete draft.id;
      const saved = await repository.saveReview(draft);
      setReviews((current) => {
        const index = current.findIndex((entry) => entry.id === saved.id);
        if (index < 0) return [...current, saved];
        const next = [...current];
        next[index] = saved;
        return next;
      });
      setReviewDraft(null);
      toast.success(t("online.content.reviewSaved"));
    } catch (caught) {
      toast.error(t(`online.error.${toOnlineError(caught).code}`));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === "products") {
        await repository.deleteProductContent(confirm.id);
        setContents((current) => current.filter((entry) => entry.product_id !== confirm.id));
      } else if (confirm.kind === "faqs") {
        await repository.deleteFaq(confirm.id);
        setFaqs((current) => current.filter((entry) => entry.id !== confirm.id));
      } else {
        await repository.deleteReview(confirm.id);
        setReviews((current) => current.filter((entry) => entry.id !== confirm.id));
      }
      toast.push(t("online.content.deleted"), "info");
      setConfirm(null);
    } catch (caught) {
      toast.error(t(`online.error.${toOnlineError(caught).code}`));
    } finally {
      setBusy(false);
    }
  };

  if (!canManage) {
    return (
      <div>
        <PageHeader title={t("online.content.title")} subtitle={t("online.content.subtitle")} />
        <Card>
          <EmptyState icon="🔒" title={t("online.settings.noAccess")} description={t("online.settings.noAccessHint")} />
        </Card>
      </div>
    );
  }

  const branded = contents.filter((content) => content.brand_en || content.brand_ar).length;
  const withSlug = contents.filter((content) => Boolean(content.slug)).length;
  const hiddenReviews = reviews.filter((review) => !review.visible).length;

  return (
    <div>
      <PageHeader
        title={t("online.content.title")}
        subtitle={t("online.content.subtitle")}
        actions={
          <>
            <Button variant="secondary" onClick={() => void load()} title={t("common.retry")}>
              ⟳
            </Button>
            <Button
              onClick={() =>
                tab === "faqs"
                  ? setFaqDraft({
                      id: "",
                      question_ar: "",
                      question_en: "",
                      answer_ar: "",
                      answer_en: "",
                      sort_order: faqs.length,
                      active: true,
                      created_at: new Date().toISOString(),
                      updated_at: new Date().toISOString(),
                    })
                  : tab === "reviews"
                    ? setReviewDraft({
                        id: "",
                        product_id: null,
                        author_name: "",
                        rating: 5,
                        body: "",
                        visible: true,
                        sort_order: reviews.length,
                        created_at: new Date().toISOString(),
                      })
                    : undefined
              }
              disabled={tab === "products"}
              title={tab === "products" ? t("online.content.pickProductHint") : undefined}
            >
              {tab === "faqs" ? t("online.content.newFaq") : t("online.content.newReview")}
            </Button>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatTile label={t("online.content.withBrand")} value={num(branded, 0)} tone="primary" />
        <StatTile label={t("online.content.withSlug")} value={num(withSlug, 0)} tone="info" />
        <StatTile label={t("online.content.faqCount")} value={num(faqs.length, 0)} tone="success" />
        <StatTile
          label={t("online.content.reviewCount")}
          value={num(reviews.length, 0)}
          tone="warning"
          hint={hiddenReviews > 0 ? t("online.content.hiddenCount", { count: num(hiddenReviews, 0) }) : undefined}
        />
      </div>

      <Card className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex rounded-xl bg-slate-100 p-1">
            {(["products", "faqs", "reviews"] as Tab[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`rounded-lg px-4 py-1.5 text-xs font-bold transition-all ${
                  tab === key ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {t(`online.content.tab.${key}`)}
              </button>
            ))}
          </div>
          {tab === "products" ? (
            <div className="w-full sm:max-w-xs">
              <TextInput
                value={search}
                leading={<SearchIcon />}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("online.content.searchProducts")}
                aria-label={t("common.search")}
                type="search"
              />
            </div>
          ) : null}
        </div>
      </Card>

      {error ? (
        <ErrorState title={t("common.error")} message={t(`online.error.${error}`)} retryLabel={t("common.retry")} onRetry={() => void load()} />
      ) : loading ? (
        <div className="alyq-card">
          <LoadingBlock label={t("common.loading")} />
        </div>
      ) : tab === "products" ? (
        filteredProducts.length === 0 ? (
          <Card>
            <EmptyState icon="📦" title={t("online.content.noProducts")} description={t("online.content.noProductsHint")} />
          </Card>
        ) : (
          <div className="alyq-card overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-bold uppercase tracking-wider text-slate-600">
                  <th className="px-4 py-3 text-start font-semibold">{t("export.col.product")}</th>
                  <th className="px-3 py-3 text-start font-semibold">{t("online.content.brand")}</th>
                  <th className="px-3 py-3 text-start font-semibold">{t("online.content.slug")}</th>
                  <th className="px-3 py-3 text-start font-semibold">{t("online.content.seo")}</th>
                  <th className="px-3 py-3 text-end font-semibold">{t("online.content.specs")}</th>
                  <th className="px-4 py-3 text-end font-semibold">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredProducts.map((product) => {
                  const content = contentByProduct.get(product.id);
                  return (
                    <tr key={product.id} className="border-b border-slate-50 transition-colors last:border-0 hover:bg-slate-50/60">
                      <td className="px-4 py-3">
                        <p className="font-semibold text-slate-900">{pick(product.name_ar, product.name_en)}</p>
                        <p className="font-mono text-[11px] text-slate-500">{product.sku}</p>
                      </td>
                      <td className="px-3 py-3 text-xs text-slate-700">
                        {content?.brand_en || content?.brand_ar ? (
                          pick(content.brand_ar, content.brand_en)
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        {content?.slug ? (
                          <span className="font-mono text-[11px] text-slate-700" dir="ltr">
                            /{content.slug}
                          </span>
                        ) : (
                          <Badge tone="warning">{t("online.content.noSlug")}</Badge>
                        )}
                      </td>
                      <td className="px-3 py-3 text-xs">
                        {content?.seo_title || content?.seo_description ? (
                          <Badge tone="success">{t("online.content.seoReady")}</Badge>
                        ) : (
                          <Badge tone="neutral">{t("online.content.seoMissing")}</Badge>
                        )}
                      </td>
                      <td className="px-3 py-3 text-end text-xs tabular-nums text-slate-600">
                        {num(content?.specs.length ?? 0, 0)}
                      </td>
                      <td className="px-4 py-3 text-end">
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setContentDraft({ product, content: draftContent(product) })}
                          >
                            {content ? t("common.edit") : t("online.content.addContent")}
                          </Button>
                          {content ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setConfirm({
                                  kind: "products",
                                  id: product.id,
                                  label: pick(product.name_ar, product.name_en),
                                })
                              }
                            >
                              {t("common.delete")}
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : tab === "faqs" ? (
        faqs.length === 0 ? (
          <Card>
            <EmptyState icon="❓" title={t("online.content.noFaqs")} description={t("online.content.noFaqsHint")} />
          </Card>
        ) : (
          <div className="space-y-3">
            {faqs
              .slice()
              .sort((a, b) => a.sort_order - b.sort_order)
              .map((faq) => (
                <Card key={faq.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-slate-900">
                        {pick(faq.question_ar, faq.question_en)}
                        <Badge tone={faq.active ? "success" : "neutral"}>
                          {faq.active ? t("online.content.visible") : t("online.content.hidden")}
                        </Badge>
                      </p>
                      <p className="mt-1 line-clamp-2 text-xs text-slate-600">
                        {pick(faq.answer_ar, faq.answer_en)}
                      </p>
                      <p className="mt-1 text-[11px] text-slate-400">
                        {t("online.content.sortOrder")}: {num(faq.sort_order, 0)}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button size="sm" variant="secondary" onClick={() => setFaqDraft(faq)}>
                        {t("common.edit")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirm({ kind: "faqs", id: faq.id, label: pick(faq.question_ar, faq.question_en) })}
                      >
                        {t("common.delete")}
                      </Button>
                    </div>
                  </div>
                </Card>
              ))}
          </div>
        )
      ) : reviews.length === 0 ? (
        <Card>
          <EmptyState icon="⭐" title={t("online.content.noReviews")} description={t("online.content.noReviewsHint")} />
        </Card>
      ) : (
        <div className="space-y-3">
          {reviews.map((review) => {
            const product = review.product_id
              ? products.find((candidate) => candidate.id === review.product_id) ?? null
              : null;
            return (
              <Card key={review.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-slate-900">
                      {review.author_name}
                      <Badge tone="warning">{"★".repeat(Math.max(1, Math.min(5, review.rating)))}</Badge>
                      <Badge tone={review.visible ? "success" : "neutral"}>
                        {review.visible ? t("online.content.visible") : t("online.content.hidden")}
                      </Badge>
                    </p>
                    <p className="mt-1 text-xs text-slate-600">{review.body}</p>
                    <p className="mt-1 text-[11px] text-slate-400">
                      {product
                        ? `${t("online.content.aboutProduct")}: ${pick(product.name_ar, product.name_en)}`
                        : t("online.content.homepageReview")}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setReviewDraft(review)}>
                      {t("common.edit")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirm({ kind: "reviews", id: review.id, label: review.author_name })}
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

      {/* product content editor */}
      <Modal
        open={contentDraft !== null}
        onClose={() => setContentDraft(null)}
        size="lg"
        title={
          contentDraft
            ? `${t("online.content.editContent")} — ${pick(contentDraft.product.name_ar, contentDraft.product.name_en)}`
            : ""
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setContentDraft(null)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void saveContent()} loading={busy}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        {contentDraft ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("online.content.brandAr")}>
                <TextInput
                  dir="rtl"
                  value={contentDraft.content.brand_ar ?? ""}
                  onChange={(event) =>
                    setContentDraft({
                      ...contentDraft,
                      content: { ...contentDraft.content, brand_ar: event.target.value },
                    })
                  }
                />
              </Field>
              <Field label={t("online.content.brandEn")} hint={t("online.content.brandHint")}>
                <TextInput
                  dir="ltr"
                  value={contentDraft.content.brand_en ?? ""}
                  onChange={(event) =>
                    setContentDraft({
                      ...contentDraft,
                      content: { ...contentDraft.content, brand_en: event.target.value },
                    })
                  }
                />
              </Field>
              <Field
                label={t("online.content.slug")}
                hint={t("online.content.slugHint")}
                className="sm:col-span-2"
                error={
                  (contentDraft.content.slug ?? "").trim() &&
                  !SLUG_PATTERN.test((contentDraft.content.slug ?? "").trim().toLowerCase())
                    ? t("online.content.slugInvalid")
                    : undefined
                }
              >
                <div className="flex gap-2">
                  <TextInput
                    dir="ltr"
                    className="font-mono"
                    value={contentDraft.content.slug ?? ""}
                    invalid={Boolean(
                      (contentDraft.content.slug ?? "").trim() &&
                        !SLUG_PATTERN.test((contentDraft.content.slug ?? "").trim().toLowerCase()),
                    )}
                    onChange={(event) =>
                      setContentDraft({
                        ...contentDraft,
                        content: { ...contentDraft.content, slug: event.target.value },
                      })
                    }
                  />
                  <Button
                    variant="secondary"
                    onClick={() =>
                      setContentDraft({
                        ...contentDraft,
                        content: {
                          ...contentDraft.content,
                          slug: slugifyAscii(
                            contentDraft.product.name_en || contentDraft.product.name_ar,
                            contentDraft.product.sku,
                          ),
                        },
                      })
                    }
                  >
                    {t("online.content.suggestSlug")}
                  </Button>
                </div>
              </Field>
              <Field label={t("online.content.seoTitle")} className="sm:col-span-2" hint={t("online.content.seoTitleHint")}>
                <TextInput
                  value={contentDraft.content.seo_title ?? ""}
                  onChange={(event) =>
                    setContentDraft({
                      ...contentDraft,
                      content: { ...contentDraft.content, seo_title: event.target.value },
                    })
                  }
                />
              </Field>
              <Field
                label={t("online.content.seoDescription")}
                className="sm:col-span-2"
                hint={t("online.content.seoDescriptionHint")}
              >
                <TextArea
                  rows={3}
                  value={contentDraft.content.seo_description ?? ""}
                  onChange={(event) =>
                    setContentDraft({
                      ...contentDraft,
                      content: { ...contentDraft.content, seo_description: event.target.value },
                    })
                  }
                />
              </Field>
            </div>

            {/* Phase 45: the editorial accordion fields — exactly the fields
                the product page renders, in the same order, so what the admin
                writes here is what the shopper reads there. */}
            <details className="rounded-xl border border-slate-200 p-3">
              <summary className="cursor-pointer text-xs font-bold text-slate-800">
                {t("online.ws.productContent")}
              </summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label={t("online.pc.shortAr")}>
                  <TextArea dir="rtl" rows={2} value={contentDraft.content.short_description_ar ?? ""} onChange={(e) => setContentDraft({ ...contentDraft, content: { ...contentDraft.content, short_description_ar: e.target.value } })} />
                </Field>
                <Field label={t("online.pc.shortEn")}>
                  <TextArea dir="ltr" rows={2} value={contentDraft.content.short_description_en ?? ""} onChange={(e) => setContentDraft({ ...contentDraft, content: { ...contentDraft.content, short_description_en: e.target.value } })} />
                </Field>
                <Field label={t("online.pc.descAr")}>
                  <TextArea dir="rtl" rows={4} value={contentDraft.content.description_ar ?? ""} onChange={(e) => setContentDraft({ ...contentDraft, content: { ...contentDraft.content, description_ar: e.target.value } })} />
                </Field>
                <Field label={t("online.pc.descEn")}>
                  <TextArea dir="ltr" rows={4} value={contentDraft.content.description_en ?? ""} onChange={(e) => setContentDraft({ ...contentDraft, content: { ...contentDraft.content, description_en: e.target.value } })} />
                </Field>
                <Field label={t("online.pc.materialsAr")}>
                  <TextArea dir="rtl" rows={2} value={contentDraft.content.materials_ar ?? ""} onChange={(e) => setContentDraft({ ...contentDraft, content: { ...contentDraft.content, materials_ar: e.target.value } })} />
                </Field>
                <Field label={t("online.pc.materialsEn")}>
                  <TextArea dir="ltr" rows={2} value={contentDraft.content.materials_en ?? ""} onChange={(e) => setContentDraft({ ...contentDraft, content: { ...contentDraft.content, materials_en: e.target.value } })} />
                </Field>
                <Field label={t("online.pc.dimensionsAr")}>
                  <TextArea dir="rtl" rows={2} value={contentDraft.content.dimensions_ar ?? ""} onChange={(e) => setContentDraft({ ...contentDraft, content: { ...contentDraft.content, dimensions_ar: e.target.value } })} />
                </Field>
                <Field label={t("online.pc.dimensionsEn")}>
                  <TextArea dir="ltr" rows={2} value={contentDraft.content.dimensions_en ?? ""} onChange={(e) => setContentDraft({ ...contentDraft, content: { ...contentDraft.content, dimensions_en: e.target.value } })} />
                </Field>
                <Field label={t("online.pc.careAr")}>
                  <TextArea dir="rtl" rows={2} value={contentDraft.content.care_ar ?? ""} onChange={(e) => setContentDraft({ ...contentDraft, content: { ...contentDraft.content, care_ar: e.target.value } })} />
                </Field>
                <Field label={t("online.pc.careEn")}>
                  <TextArea dir="ltr" rows={2} value={contentDraft.content.care_en ?? ""} onChange={(e) => setContentDraft({ ...contentDraft, content: { ...contentDraft.content, care_en: e.target.value } })} />
                </Field>
                <Field label={t("online.pc.shippingAr")}>
                  <TextArea dir="rtl" rows={2} value={contentDraft.content.shipping_ar ?? ""} onChange={(e) => setContentDraft({ ...contentDraft, content: { ...contentDraft.content, shipping_ar: e.target.value } })} />
                </Field>
                <Field label={t("online.pc.shippingEn")}>
                  <TextArea dir="ltr" rows={2} value={contentDraft.content.shipping_en ?? ""} onChange={(e) => setContentDraft({ ...contentDraft, content: { ...contentDraft.content, shipping_en: e.target.value } })} />
                </Field>
                <Field label={t("online.pc.returnsAr")}>
                  <TextArea dir="rtl" rows={2} value={contentDraft.content.returns_ar ?? ""} onChange={(e) => setContentDraft({ ...contentDraft, content: { ...contentDraft.content, returns_ar: e.target.value } })} />
                </Field>
                <Field label={t("online.pc.returnsEn")}>
                  <TextArea dir="ltr" rows={2} value={contentDraft.content.returns_en ?? ""} onChange={(e) => setContentDraft({ ...contentDraft, content: { ...contentDraft.content, returns_en: e.target.value } })} />
                </Field>
                <Field label={t("online.pc.giftAr")}>
                  <TextArea dir="rtl" rows={2} value={contentDraft.content.gift_note_ar ?? ""} onChange={(e) => setContentDraft({ ...contentDraft, content: { ...contentDraft.content, gift_note_ar: e.target.value } })} />
                </Field>
                <Field label={t("online.pc.giftEn")}>
                  <TextArea dir="ltr" rows={2} value={contentDraft.content.gift_note_en ?? ""} onChange={(e) => setContentDraft({ ...contentDraft, content: { ...contentDraft.content, gift_note_en: e.target.value } })} />
                </Field>
              </div>
              <div className="mt-3 border-t border-slate-100 pt-3">
                <p className="mb-2 text-xs font-bold text-slate-800">{t("online.pc.media")}</p>
                <MediaListEditor
                  media={contentDraft.content.media ?? []}
                  onChange={(media: ProductContentMediaItem[]) =>
                    setContentDraft({ ...contentDraft, content: { ...contentDraft.content, media } })
                  }
                />
              </div>
            </details>

            <div className="rounded-xl border border-slate-200 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-bold text-slate-800">{t("online.content.specs")}</p>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    setContentDraft({
                      ...contentDraft,
                      content: {
                        ...contentDraft.content,
                        specs: [...contentDraft.content.specs, emptySpec()],
                      },
                    })
                  }
                >
                  {t("online.content.addSpec")}
                </Button>
              </div>
              <p className="mt-0.5 text-[11px] font-medium text-slate-500">{t("online.content.specsHint")}</p>
              {contentDraft.content.specs.length === 0 ? (
                <p className="mt-2 text-xs font-semibold text-slate-500">{t("online.content.noSpecs")}</p>
              ) : null}
              <div className="mt-2 space-y-2">
                {contentDraft.content.specs.map((spec, index) => (
                  <div key={spec.id} className="grid gap-2 rounded-lg bg-slate-50 p-2 sm:grid-cols-2">
                    <TextInput
                      dir="rtl"
                      className="h-9 text-xs"
                      placeholder={t("online.content.specLabelAr")}
                      value={spec.label_ar}
                      onChange={(event) => {
                        const specs = [...contentDraft.content.specs];
                        specs[index] = { ...spec, label_ar: event.target.value };
                        setContentDraft({ ...contentDraft, content: { ...contentDraft.content, specs } });
                      }}
                      aria-label={t("online.content.specLabelAr")}
                    />
                    <TextInput
                      dir="ltr"
                      className="h-9 text-xs"
                      placeholder={t("online.content.specLabelEn")}
                      value={spec.label_en}
                      onChange={(event) => {
                        const specs = [...contentDraft.content.specs];
                        specs[index] = { ...spec, label_en: event.target.value };
                        setContentDraft({ ...contentDraft, content: { ...contentDraft.content, specs } });
                      }}
                      aria-label={t("online.content.specLabelEn")}
                    />
                    <TextInput
                      dir="rtl"
                      className="h-9 text-xs"
                      placeholder={t("online.content.specValueAr")}
                      value={spec.value_ar}
                      onChange={(event) => {
                        const specs = [...contentDraft.content.specs];
                        specs[index] = { ...spec, value_ar: event.target.value };
                        setContentDraft({ ...contentDraft, content: { ...contentDraft.content, specs } });
                      }}
                      aria-label={t("online.content.specValueAr")}
                    />
                    <TextInput
                      dir="ltr"
                      className="h-9 text-xs"
                      placeholder={t("online.content.specValueEn")}
                      value={spec.value_en}
                      onChange={(event) => {
                        const specs = [...contentDraft.content.specs];
                        specs[index] = { ...spec, value_en: event.target.value };
                        setContentDraft({ ...contentDraft, content: { ...contentDraft.content, specs } });
                      }}
                      aria-label={t("online.content.specValueEn")}
                    />
                    <div className="sm:col-span-2 flex justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setContentDraft({
                            ...contentDraft,
                            content: {
                              ...contentDraft.content,
                              specs: contentDraft.content.specs.filter((entry) => entry.id !== spec.id),
                            },
                          })
                        }
                      >
                        {t("common.delete")}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* FAQ editor */}
      <Modal
        open={faqDraft !== null}
        onClose={() => setFaqDraft(null)}
        title={faqDraft?.id ? t("online.content.editFaq") : t("online.content.newFaq")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setFaqDraft(null)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => void saveFaq()}
              loading={busy}
              disabled={
                !faqDraft ||
                (!faqDraft.question_ar.trim() && !faqDraft.question_en.trim()) ||
                (!faqDraft.answer_ar.trim() && !faqDraft.answer_en.trim())
              }
            >
              {t("common.save")}
            </Button>
          </>
        }
      >
        {faqDraft ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("online.content.questionAr")} required>
                <TextInput
                  dir="rtl"
                  value={faqDraft.question_ar}
                  onChange={(event) => setFaqDraft({ ...faqDraft, question_ar: event.target.value })}
                />
              </Field>
              <Field label={t("online.content.questionEn")} required>
                <TextInput
                  dir="ltr"
                  value={faqDraft.question_en}
                  onChange={(event) => setFaqDraft({ ...faqDraft, question_en: event.target.value })}
                />
              </Field>
            </div>
            <Field label={t("online.content.answerAr")}>
              <TextArea
                rows={3}
                dir="rtl"
                value={faqDraft.answer_ar}
                onChange={(event) => setFaqDraft({ ...faqDraft, answer_ar: event.target.value })}
              />
            </Field>
            <Field label={t("online.content.answerEn")}>
              <TextArea
                rows={3}
                dir="ltr"
                value={faqDraft.answer_en}
                onChange={(event) => setFaqDraft({ ...faqDraft, answer_en: event.target.value })}
              />
            </Field>
            <Field label={t("online.content.sortOrder")} hint={t("online.content.sortOrderHint")}>
              <TextInput
                type="number"
                min={0}
                value={String(faqDraft.sort_order)}
                onChange={(event) =>
                  setFaqDraft({ ...faqDraft, sort_order: Math.max(0, Number(event.target.value) || 0) })
                }
              />
            </Field>
            <ToggleSwitch
              checked={faqDraft.active}
              onChange={(checked) => setFaqDraft({ ...faqDraft, active: checked })}
              label={t("online.content.visible")}
              hint={t("online.content.faqVisibleHint")}
            />
          </div>
        ) : null}
      </Modal>

      {/* review editor */}
      <Modal
        open={reviewDraft !== null}
        onClose={() => setReviewDraft(null)}
        title={reviewDraft?.id ? t("online.content.editReview") : t("online.content.newReview")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setReviewDraft(null)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => void saveReview()}
              loading={busy}
              disabled={!reviewDraft || !reviewDraft.author_name.trim() || !reviewDraft.body.trim()}
            >
              {t("common.save")}
            </Button>
          </>
        }
      >
        {reviewDraft ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("online.content.authorName")} required>
                <TextInput
                  value={reviewDraft.author_name}
                  onChange={(event) => setReviewDraft({ ...reviewDraft, author_name: event.target.value })}
                />
              </Field>
              <Field label={t("online.content.rating")}>
                <SelectInput
                  value={String(reviewDraft.rating)}
                  onChange={(event) =>
                    setReviewDraft({
                      ...reviewDraft,
                      rating: Math.max(1, Math.min(5, Number(event.target.value) || 5)),
                    })
                  }
                >
                  {[5, 4, 3, 2, 1].map((value) => (
                    <option key={value} value={String(value)}>
                      {"★".repeat(value)}
                    </option>
                  ))}
                </SelectInput>
              </Field>
            </div>
            <Field label={t("online.content.reviewBody")} required>
              <TextArea
                rows={4}
                value={reviewDraft.body}
                onChange={(event) => setReviewDraft({ ...reviewDraft, body: event.target.value })}
              />
            </Field>
            <Field label={t("online.content.aboutProduct")} hint={t("online.content.aboutProductHint")}>
              <SelectInput
                value={reviewDraft.product_id ?? ""}
                onChange={(event) =>
                  setReviewDraft({ ...reviewDraft, product_id: event.target.value || null })
                }
              >
                <option value="">{t("online.content.homepageReview")}</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {pick(product.name_ar, product.name_en)} · {product.sku}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <Field label={t("online.content.sortOrder")}>
              <TextInput
                type="number"
                min={0}
                value={String(reviewDraft.sort_order)}
                onChange={(event) =>
                  setReviewDraft({ ...reviewDraft, sort_order: Math.max(0, Number(event.target.value) || 0) })
                }
              />
            </Field>
            <ToggleSwitch
              checked={reviewDraft.visible}
              onChange={(checked) => setReviewDraft({ ...reviewDraft, visible: checked })}
              label={t("online.content.visible")}
              hint={t("online.content.reviewVisibleHint")}
            />
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={confirm !== null}
        title={t("online.content.deleteTitle")}
        body={t("online.content.deleteBody", { label: confirm?.label ?? "" })}
        loading={busy}
        onConfirm={() => void remove()}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
