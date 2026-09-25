/** Browser-local shopper profile, using the same StoreAccountProvider as legacy.
 * Order history is fetched by the existing per-reference + phone lookup;
 * reorder is checked by exact variant UUID before touching the shared cart. */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useStoreAccount } from "../hooks/StoreAccountProvider";
import { storeLineKey, useStoreCart } from "../hooks/StoreCartProvider";
import { useStorefront } from "../hooks/StorefrontProvider";
import { findCatalogProduct, searchCatalog, EMPTY_CATALOG_FILTERS } from "../services/catalogQuery";
import { applyDocumentMeta, clearDocumentMeta } from "../services/seo";
import type { CustomerAddress, OnlineOrder } from "../types";
import { planV2Reorder, type V2ReorderPlan } from "./journeyModel";
import { V2Panel } from "./JourneyParts";
import { V2ProductCard } from "./ProductCard";
import { V2ProductGrid } from "./Primitives";

type Tab = "profile" | "addresses" | "wishlist" | "orders";
const tabs: Tab[] = ["profile", "addresses", "wishlist", "orders"];
function tabFrom(raw: string | null): Tab { return tabs.find((item) => item === raw) ?? "profile"; }
const newAddress = (): CustomerAddress => ({ id: "", label: "", full_name: "", phone: "",
  city: "", area: "", street: "", building: "", floor: "", apartment: "", notes: "", is_default: false });
const addressFields = ["label", "full_name", "phone", "city", "area", "street", "building", "floor", "apartment"] as const;

export function StorefrontV2Account() {
  const { t, pick, money, lang } = useI18n();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { products, contents, variants, catalogContext, loading: catalogueLoading,
    error: catalogueError, refresh: refreshCatalog } = useStorefront();
  const { addMany, lines } = useStoreCart();
  const account = useStoreAccount();
  const { customer, loading, busy, error, clearError, register, login, logout, updateProfile,
    addresses, addAddress, updateAddress, removeAddress, setDefaultAddress, wishlist,
    history, historyLoading, refreshHistory } = account;
  const [mode, setMode] = useState<"login" | "register">("login");
  const tab = tabFrom(params.get("tab"));
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [regName, setRegName] = useState("");
  const [regPhone, setRegPhone] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [profileName, setProfileName] = useState(customer?.name ?? "");
  const [profilePhone, setProfilePhone] = useState(customer?.phone ?? "");
  const [profileEmail, setProfileEmail] = useState(customer?.email ?? "");
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState<CustomerAddress | null>(null);
  const [reorderProblem, setReorderProblem] = useState("");
  const [reorderSuccess, setReorderSuccess] = useState("");
  const [pendingReorder, setPendingReorder] = useState<{
    order: OnlineOrder;
    ready: V2ReorderPlan["ready"];
    unavailable: string[];
    before: Map<string, number>;
  } | null>(null);

  useEffect(() => {
    applyDocumentMeta({ title: t("store.account.title"), description: "", noIndex: true });
    return () => clearDocumentMeta();
  }, [t]);
  useEffect(() => {
    if (customer) { setProfileName(customer.name); setProfilePhone(customer.phone); setProfileEmail(customer.email ?? ""); }
  }, [customer]);
  // The account provider is mounted across sibling V2 routes. A newly placed
  // order can therefore arrive after its initial history effect: revisit the
  // same private reference+phone lookups whenever the shopper opens Orders.
  useEffect(() => { if (customer && tab === "orders") void refreshHistory(); }, [customer, tab, refreshHistory]);
  const wishlistEntries = useMemo(() => wishlist.flatMap((id) => {
    const product = findCatalogProduct(id, products, contents);
    if (!product) return [];
    return searchCatalog([product], { ...EMPTY_CATALOG_FILTERS, productIds: [product.id] }, catalogContext);
  }), [wishlist, products, contents, catalogContext]);

  const saveProfile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSaved(false);
    void updateProfile({ name: profileName.trim(), phone: profilePhone.trim(),
      email: profileEmail.trim() || null }).then(setSaved);
  };
  const saveAddress = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft || !draft.city.trim() || !draft.area.trim() || !draft.street.trim()) return;
    const value = { ...draft, id: draft.id || `addr_${Date.now().toString(36)}` };
    void (draft.id ? updateAddress(value) : addAddress(value)).then((ok) => { if (ok) setDraft(null); });
  };
  // Include both the historical item name and SKU, never an inferred new
  // colour/size. A repeated SKU is only reported once in the warning.
  const reorderLabels = useCallback((order: OnlineOrder, skus: string[]) =>
    [...new Set(skus)].map((sku) => {
      const item = order.items.find((row) => row.sku === sku);
      const name = item ? pick(item.name_ar, item.name_en).trim() : "";
      return name ? `${name} (${sku})` : sku;
    }).join(", "), [pick]);

  // addMany's immediate count is not reliable under React's deferred state
  // updaters: it can return 0 even when it actually adds a line. Observe the
  // committed shared-cart lines before claiming success or refusing a shelf.
  useEffect(() => {
    if (!pendingReorder) return;
    const after = new Map<string, number>();
    for (const line of lines) {
      const key = storeLineKey(line.product_id, line.variant_id);
      after.set(key, (after.get(key) ?? 0) + line.quantity);
    }
    const cartChanged = pendingReorder.ready.some((line) => {
      const key = storeLineKey(line.product_id, line.variant_id);
      return (after.get(key) ?? 0) > (pendingReorder.before.get(key) ?? 0);
    });
    const timer = window.setTimeout(() => {
      const expected = new Map(pendingReorder.before);
      const unavailable = [...pendingReorder.unavailable];
      let added = 0;
      for (const line of pendingReorder.ready) {
        const key = storeLineKey(line.product_id, line.variant_id);
        const target = (expected.get(key) ?? 0) + line.quantity;
        expected.set(key, target);
        if ((after.get(key) ?? 0) >= target) added++;
        else unavailable.push(pendingReorder.order.items.find((item) => item.product_id === line.product_id &&
          (item.variant_id ?? null) === line.variant_id)?.sku ?? line.product_id);
      }
      if (unavailable.length) setReorderProblem(reorderLabels(pendingReorder.order, unavailable));
      if (added) setReorderSuccess(pendingReorder.order.order_number);
      setPendingReorder(null);
      // All-valid keeps the original navigation; partial reorder stays here
      // with its specific warning and explicit V2 bag link.
      if (added && !unavailable.length) navigate("/store/cart");
    // A deferred updater may not have committed yet at the first effect. Wait
    // for the cart change; if every line is refused, eventually show the error.
    }, cartChanged ? 50 : 750);
    return () => window.clearTimeout(timer);
  }, [lines, navigate, pendingReorder, reorderLabels]);

  const reorder = (order: OnlineOrder) => {
    if (pendingReorder || catalogueLoading || catalogueError) return;
    setReorderProblem(""); setReorderSuccess("");
    const plan = planV2Reorder(order, products, variants, catalogContext.reserved,
      catalogContext.reservedVariant, lines);
    if (!plan.ready.length) {
      setReorderProblem(reorderLabels(order, plan.unavailable) || t("store.v2.journey.reorderUnavailable"));
      return;
    }
    const before = new Map<string, number>();
    for (const line of lines) {
      const key = storeLineKey(line.product_id, line.variant_id);
      before.set(key, (before.get(key) ?? 0) + line.quantity);
    }
    addMany(plan.ready); // the shared cart independently rechecks each exact line
    setPendingReorder({ order, ready: plan.ready, unavailable: plan.unavailable, before });
  };

  return <div className="v2-journey v2-container" data-testid="v2-account">
    <p className="v2-eyebrow">{t("store.v2.eyebrow")}</p>
    <div className="v2-journey-title"><h1>{customer ? t("store.account.hello", { name: customer.name }) : t("store.account.title")}</h1>
      {customer ? <button type="button" className="v2-outline-button" disabled={busy} onClick={() => void logout()}>
        {t("store.account.signOut")}</button> : null}</div>
    <p className="v2-small">{t("store.v2.journey.browserLocal")}</p>
    {error ? <p role="alert" className="v2-alert">{t(`store.error.${error}` as never)}
      <button type="button" onClick={clearError}>{t("common.dismiss")}</button></p> : null}
    {loading ? <p role="status" className="v2-small">{t("common.loading")}</p> : !customer ?
      <div className="v2-account-auth"><div className="v2-account-tabs" role="group" aria-label={t("store.account.title")}>
        <button type="button" aria-pressed={mode === "login"} onClick={() => setMode("login")}>{t("store.account.signIn")}</button>
        <button type="button" aria-pressed={mode === "register"} onClick={() => setMode("register")}>{t("store.account.register")}</button>
      </div><V2Panel>
        {mode === "login" ? <form className="v2-account-form" onSubmit={(event) => {
          event.preventDefault(); void login({ identifier, password });
        }}>
          <label className="v2-field">{t("store.account.identifier")}
            <input autoComplete="username" value={identifier} onChange={(event) => setIdentifier(event.target.value)}
              placeholder={t("store.account.identifierPlaceholder")} required /></label>
          <label className="v2-field">{t("store.account.password")}
            <input type="password" autoComplete="current-password" value={password}
              onChange={(event) => setPassword(event.target.value)} required /></label>
          <button type="submit" disabled={busy || !identifier.trim() || !password} className="v2-primary-button">
            {busy ? t("common.loading") : t("store.account.signIn")}</button>
          <p className="v2-small">{t("store.account.guestCheckoutNote")}{" "}
            <Link to="/store/track">{t("store.track.title")}</Link></p>
        </form> : <form className="v2-account-form" onSubmit={(event) => {
          event.preventDefault(); void register({ name: regName.trim(), phone: regPhone.trim(),
            email: regEmail.trim() || null, password: regPassword });
        }}>
          <label className="v2-field">{t("store.checkout.fullName")}
            <input value={regName} onChange={(event) => setRegName(event.target.value)} autoComplete="name" required /></label>
          <label className="v2-field">{t("store.checkout.phone")}
            <input dir="ltr" inputMode="tel" autoComplete="tel" value={regPhone} onChange={(event) => setRegPhone(event.target.value)} required /></label>
          <label className="v2-field">{t("store.checkout.email")} ({t("common.optional")})
            <input type="email" autoComplete="email" value={regEmail} onChange={(event) => setRegEmail(event.target.value)} /></label>
          <label className="v2-field">{t("store.account.password")}
            <input type="password" autoComplete="new-password" value={regPassword}
              onChange={(event) => setRegPassword(event.target.value)} minLength={6} required /></label>
          <p className="v2-small">{t("store.account.passwordRule")}</p>
          <button type="submit" disabled={busy || !regName.trim() || !regPhone.trim() || regPassword.length < 6}
            className="v2-primary-button">{busy ? t("common.loading") : t("store.account.createAccount")}</button>
        </form>}
      </V2Panel></div> : <div className="v2-account-grid">
        <nav className="v2-account-nav" aria-label={t("store.account.title")}>
          {tabs.map((item) => <button key={item} type="button" aria-current={tab === item ? "page" : undefined}
            onClick={() => setParams({ tab: item }, { replace: true })}>
            {t(`store.account.tab${item[0].toUpperCase()}${item.slice(1)}` as never)}
            {item === "wishlist" && wishlist.length ? ` (${wishlist.length})` : ""}
            {item === "orders" && history.length ? ` (${history.length})` : ""}</button>)}
        </nav>
        <div className="v2-account-content">
          {tab === "profile" ? <V2Panel title={t("store.account.tabProfile")}>
            <form className="v2-account-form" onSubmit={saveProfile}><div className="v2-form-grid">
              <label className="v2-field">{t("store.checkout.fullName")}
                <input value={profileName} onChange={(event) => setProfileName(event.target.value)} required /></label>
              <label className="v2-field">{t("store.checkout.phone")}
                <input dir="ltr" inputMode="tel" value={profilePhone} onChange={(event) => setProfilePhone(event.target.value)} required /></label>
              <label className="v2-field v2-field-wide">{t("store.checkout.email")}
                <input type="email" value={profileEmail} onChange={(event) => setProfileEmail(event.target.value)} /></label>
            </div><button type="submit" disabled={busy || !profileName.trim() || !profilePhone.trim()} className="v2-primary-button">
              {busy ? t("common.loading") : t("common.save")}</button>
              {saved ? <p role="status" className="v2-field-success">{t("store.account.saved")}</p> : null}
              <p className="v2-small">{t("store.account.profileNote")}</p>
            </form>
          </V2Panel> : null}
          {tab === "addresses" ? <><V2Panel title={t("store.account.tabAddresses")}>
            <button type="button" className="v2-outline-button" onClick={() => setDraft({ ...newAddress(),
              full_name: customer.name, phone: customer.phone })}>{t("store.account.addAddress")}</button>
            {!addresses.length && !draft ? <p className="v2-small">{t("store.account.noAddresses")}</p> : null}
            <div className="v2-address-cards">{addresses.map((item) => <article key={item.id} className="v2-address-card">
              <strong>{item.label || t("store.account.address")}</strong>
              {item.is_default ? <span className="v2-small"> · {t("store.account.defaultAddress")}</span> : null}
              <p>{[item.street, item.building, item.area, item.city].filter(Boolean).join("، ")}</p>
              <p className="v2-small">{item.full_name} · <span dir="ltr">{item.phone}</span></p>
              <div className="v2-inline-actions">
                {!item.is_default ? <button type="button" disabled={busy} onClick={() => void setDefaultAddress(item.id)}>{t("store.account.makeDefault")}</button> : null}
                <button type="button" onClick={() => setDraft(item)}>{t("common.edit")}</button>
                <button type="button" disabled={busy} onClick={() => void removeAddress(item.id)}>{t("common.delete")}</button>
              </div>
            </article>)}</div>
          </V2Panel>
          {draft ? <V2Panel title={draft.id ? t("common.edit") : t("store.account.addAddress")}>
            <form className="v2-account-form" onSubmit={saveAddress}><div className="v2-form-grid">
              {addressFields.map((field) => <label key={field} className="v2-field">
                {field === "label" ? t("store.account.addressLabel") : field === "full_name" ? t("store.checkout.fullName") :
                  field === "phone" ? t("store.checkout.phone") : t(`store.checkout.${field}`)}
                <input value={draft[field]} required={field === "city" || field === "area" || field === "street"}
                  onChange={(event) => setDraft((current) => current ? { ...current, [field]: event.target.value } : current)} />
              </label>)}
              <label className="v2-field v2-field-wide">{t("store.checkout.addressNotes")}
                <input value={draft.notes ?? ""} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label>
            </div><div className="v2-inline-actions"><button type="submit" disabled={busy || !draft.city.trim() || !draft.area.trim() || !draft.street.trim()}
              className="v2-primary-button">{t("common.save")}</button>
              <button type="button" onClick={() => setDraft(null)}>{t("common.cancel")}</button></div></form>
          </V2Panel> : null}</> : null}
          {tab === "wishlist" ? <V2Panel title={t("store.account.tabWishlist")}>
            {!wishlistEntries.length ? <p className="v2-small">{t("store.wishlist.empty")}</p> :
              <V2ProductGrid>{wishlistEntries.map((entry) => <V2ProductCard key={entry.product.id} entry={entry} />)}</V2ProductGrid>}
          </V2Panel> : null}
          {tab === "orders" ? <V2Panel title={t("store.account.tabOrders")}>
            <button type="button" className="v2-text-link" onClick={() => void refreshHistory()} disabled={historyLoading}>
              {historyLoading ? t("common.loading") : t("common.refresh")}</button>
            {!history.length ? <p className="v2-small">{historyLoading ? t("common.loading") : t("store.account.noOrders")}</p> : null}
            {history.length && catalogueLoading ? <p role="status" className="v2-small">
              {t("common.loading")}</p> : null}
            {history.length && catalogueError ? <p role="alert" className="v2-alert">
              {t("store.v2.error")}{" "}<button type="button" onClick={() => void refreshCatalog()}>
                {t("store.v2.retry")}</button></p> : null}
            {reorderProblem ? <p role="alert" className="v2-alert" data-testid="v2-reorder-error">
              {t("store.v2.journey.reorderUnavailable")}{reorderProblem === t("store.v2.journey.reorderUnavailable") ? "" : ` · ${reorderProblem}`}</p> : null}
            {reorderSuccess ? <p role="status" className="v2-field-success">{t("store.account.reordered")}: {reorderSuccess}
              {reorderProblem ? <> · {t("store.v2.journey.reorderPartial")}{" "}
                <Link to="/store/cart">{t("store.v2.bag")} ↗</Link></> : null}</p> : null}
            <div className="v2-history">{history.map((order) => <article key={order.id} className="v2-history-card" data-testid="v2-history-order">
              <div><strong dir="ltr">{order.order_number}</strong><span className="v2-small">
                {new Date(order.created_at).toLocaleDateString(lang === "ar" ? "ar-EG" : "en-GB")} · {t("store.cart.itemCount", {
                  count: order.items.reduce((sum, item) => sum + item.quantity, 0) })}</span></div>
              <div className="v2-order-badges"><span>{t(`online.status.${order.status}` as never)}</span>
                <span>{t(`online.paymentStatus.${order.payment_status}` as never)}</span></div>
              <p>{order.items.map((item) => pick(item.name_ar, item.name_en)).join("، ")}</p>
              <strong>{money(order.total)}</strong>
              <div className="v2-inline-actions"><Link className="v2-outline-button" to="/store/track"
                state={{ number: order.order_number, phone: order.customer_phone }}>{t("store.account.viewOrder")}</Link>
                {order.status !== "cancelled" ? <button type="button" className="v2-primary-button"
                  disabled={Boolean(pendingReorder) || catalogueLoading || Boolean(catalogueError)}
                  onClick={() => reorder(order)}>
                  {t("store.account.reorder")}</button> : null}</div>
            </article>)}</div>
          </V2Panel> : null}
        </div>
      </div>}
  </div>;
}
