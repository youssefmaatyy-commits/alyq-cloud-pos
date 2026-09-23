/**
 * Customer accounts.
 *
 * One screen for four jobs: getting in, keeping the details right, keeping the
 * addresses a delivery driver can actually use, and getting back to a past order
 * — including putting its lines in the cart again, which is what a regular
 * customer of a shop like this one does most often.
 *
 * History is looked up per order rather than listed from the browser, so what a
 * shopper sees here is what the shop's own records say (see
 * `StoreAccountProvider`). A guest can still buy; only saving needs an account.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { cn } from "@/utils/cn";
import { useStoreAccount } from "../hooks/StoreAccountProvider";
import { useStoreCart } from "../hooks/StoreCartProvider";
import { useStorefront } from "../hooks/StorefrontProvider";
import { findCatalogProduct, searchCatalog, EMPTY_CATALOG_FILTERS } from "../services/catalogQuery";
import type { CustomerAddress, OnlineOrder } from "../types";
import {
  Money,
  OrderStatusPill,
  PaymentStatusPill,
} from "../components/storefront/StorePrimitives";
import { ProductCard, ProductGrid } from "../components/storefront/ProductCard";
import { applyDocumentMeta, clearDocumentMeta } from "../services/seo";

type SignedOutTab = "login" | "register";
type SignedInTab = "profile" | "addresses" | "wishlist" | "orders";

const blankAddress = (): CustomerAddress => ({
  id: "",
  label: "",
  full_name: "",
  phone: "",
  city: "",
  area: "",
  street: "",
  building: "",
  floor: "",
  apartment: "",
  notes: "",
  is_default: false,
});

export function StoreAccountPage() {
  const { t, pick } = useI18n();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { products, contents, contentByProduct, catalogContext } = useStorefront();
  const { addMany } = useStoreCart();
  const {
    customer,
    loading,
    busy,
    error,
    clearError,
    register,
    login,
    logout,
    updateProfile,
    addresses,
    addAddress,
    updateAddress,
    removeAddress,
    setDefaultAddress,
    wishlist,
    history,
    historyLoading,
    refreshHistory,
    reorderLines,
  } = useStoreAccount();

  const signedIn = Boolean(customer);
  const [outTab, setOutTab] = useState<SignedOutTab>("login");
  const [inTab, setInTab] = useState<SignedInTab>(
    (params.get("tab") as SignedInTab) || "profile",
  );

  // sign-in form
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  // register form
  const [regName, setRegName] = useState("");
  const [regPhone, setRegPhone] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regPassword, setRegPassword] = useState("");
  // profile form
  const [profileName, setProfileName] = useState(customer?.name ?? "");
  const [profilePhone, setProfilePhone] = useState(customer?.phone ?? "");
  const [profileEmail, setProfileEmail] = useState(customer?.email ?? "");
  const [saved, setSaved] = useState(false);
  // address editor
  const [draft, setDraft] = useState<CustomerAddress | null>(null);
  const [reordered, setReordered] = useState<string | null>(null);

  useEffect(() => {
    applyDocumentMeta({ title: t("store.account.title"), description: "", noIndex: true });
    return () => clearDocumentMeta();
  }, [t]);

  useEffect(() => {
    if (customer) {
      setProfileName(customer.name);
      setProfilePhone(customer.phone);
      setProfileEmail(customer.email ?? "");
    }
  }, [customer]);

  useEffect(() => {
    if (signedIn) setParams({ tab: inTab }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inTab, signedIn]);

  const wishlistEntries = useMemo(() => {
    if (!signedIn) return [];
    return wishlist
      .map((id) => {
        const product = findCatalogProduct(id, products, contents);
        if (!product) return null;
        return (
          searchCatalog([product], { ...EMPTY_CATALOG_FILTERS, productIds: [product.id] }, catalogContext)[0] ??
          null
        );
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  }, [catalogContext, contentByProduct, contents, products, signedIn, wishlist]);

  const inputClass =
    "w-full rounded-lg border border-[var(--store-border)] bg-[var(--store-surface)] px-3 py-2 text-sm text-[var(--store-text-primary)] outline-none transition focus:border-[var(--store-primary)]";

  const errorText = error ? t(`store.error.${error}` as never) : null;

  const reorder = async (order: OnlineOrder) => {
    const added = addMany(reorderLines(order));
    setReordered(added > 0 ? order.order_number : null);
    if (added > 0) navigate("/store/cart");
  };

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-20 text-center text-sm font-semibold text-[var(--store-text-secondary)]">
        {t("common.loading")}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[var(--store-max-width,72rem)] px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-black tracking-tight text-[var(--store-text-primary)]">
          {signedIn ? t("store.account.hello", { name: customer?.name ?? "" }) : t("store.account.title")}
        </h1>
        {signedIn ? (
          <button
            type="button"
            onClick={() => void logout()}
            className="border border-[var(--store-border)] px-4 py-2 text-xs font-black text-[var(--store-text-secondary)] transition hover:text-rose-600"
            style={{ borderRadius: "var(--store-radius-button)" }}
          >
            {t("store.account.signOut")}
          </button>
        ) : null}
      </div>

      {errorText ? (
        <div
          className="mt-4 flex items-center justify-between gap-3 border border-rose-200 bg-rose-50 p-3 text-sm font-bold text-rose-800"
          style={{ borderRadius: "var(--store-radius)" }}
          role="alert"
        >
          {errorText}
          <button type="button" onClick={clearError} className="shrink-0 underline">
            {t("common.dismiss")}
          </button>
        </div>
      ) : null}

      {!signedIn ? (
        <div className="mx-auto mt-6 max-w-md">
          <div className="flex gap-1 rounded-xl bg-[var(--store-surface-muted)] p-1">
            {(["login", "register"] as SignedOutTab[]).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setOutTab(tab)}
                className={cn(
                  "flex-1 rounded-lg px-3 py-2 text-sm font-black transition",
                  outTab === tab
                    ? "bg-[var(--store-surface)] text-[var(--store-primary)] shadow-sm"
                    : "text-[var(--store-text-secondary)]",
                )}
              >
                {tab === "login" ? t("store.account.signIn") : t("store.account.register")}
              </button>
            ))}
          </div>

          <div className="mt-4 border border-[var(--store-border)] bg-[var(--store-surface)] p-4" style={{ borderRadius: "var(--store-radius)" }}>
            {outTab === "login" ? (
              <form
                className="flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void login({ identifier, password });
                }}
              >
                <label className="block">
                  <span className="mb-1 block text-xs font-bold text-[var(--store-text-primary)]">
                    {t("store.account.identifier")}
                  </span>
                  <input
                    value={identifier}
                    onChange={(event) => setIdentifier(event.target.value)}
                    className={inputClass}
                    autoComplete="username"
                    placeholder={t("store.account.identifierPlaceholder")}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-bold text-[var(--store-text-primary)]">
                    {t("store.account.password")}
                  </span>
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className={inputClass}
                    autoComplete="current-password"
                  />
                </label>
                <button
                  type="submit"
                  disabled={busy || !identifier.trim() || !password}
                  className="bg-[var(--store-primary)] px-4 py-3 text-sm font-black text-[var(--store-on-primary)] transition hover:bg-[var(--store-primary-hover)] disabled:opacity-40"
                  style={{ borderRadius: "var(--store-radius-button)" }}
                >
                  {busy ? t("common.loading") : t("store.account.signIn")}
                </button>
                <p className="text-[11px] leading-relaxed text-[var(--store-text-secondary)]">
                  {t("store.account.guestCheckoutNote")}{" "}
                  <Link to="/store/track" className="font-bold text-[var(--store-primary)] hover:underline">
                    {t("store.track.title")}
                  </Link>
                </p>
              </form>
            ) : (
              <form
                className="flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void register({
                    name: regName.trim(),
                    phone: regPhone.trim(),
                    email: regEmail.trim() || null,
                    password: regPassword,
                  });
                }}
              >
                <label className="block">
                  <span className="mb-1 block text-xs font-bold text-[var(--store-text-primary)]">
                    {t("store.checkout.fullName")}
                  </span>
                  <input value={regName} onChange={(event) => setRegName(event.target.value)} className={inputClass} autoComplete="name" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-bold text-[var(--store-text-primary)]">
                    {t("store.checkout.phone")}
                  </span>
                  <input
                    value={regPhone}
                    onChange={(event) => setRegPhone(event.target.value)}
                    className={inputClass}
                    inputMode="tel"
                    autoComplete="tel"
                    placeholder="01xxxxxxxxx"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-bold text-[var(--store-text-primary)]">
                    {t("store.checkout.email")} <span className="font-medium text-[var(--store-text-secondary)]">({t("common.optional")})</span>
                  </span>
                  <input value={regEmail} onChange={(event) => setRegEmail(event.target.value)} className={inputClass} type="email" autoComplete="email" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-bold text-[var(--store-text-primary)]">
                    {t("store.account.password")}
                  </span>
                  <input
                    type="password"
                    value={regPassword}
                    onChange={(event) => setRegPassword(event.target.value)}
                    className={inputClass}
                    autoComplete="new-password"
                  />
                </label>
                <button
                  type="submit"
                  disabled={busy || !regName.trim() || !regPhone.trim() || regPassword.length < 6}
                  className="bg-[var(--store-primary)] px-4 py-3 text-sm font-black text-[var(--store-on-primary)] transition hover:bg-[var(--store-primary-hover)] disabled:opacity-40"
                  style={{ borderRadius: "var(--store-radius-button)" }}
                >
                  {busy ? t("common.loading") : t("store.account.createAccount")}
                </button>
                <p className="text-[11px] leading-relaxed text-[var(--store-text-secondary)]">
                  {t("store.account.passwordRule")}
                </p>
              </form>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-6 grid gap-6 lg:grid-cols-[13rem_1fr]">
          <nav className="flex gap-1 overflow-x-auto rounded-xl bg-[var(--store-surface-muted)] p-1 lg:flex-col lg:overflow-visible" aria-label={t("store.account.title")}>
            {(
              [
                ["profile", t("store.account.tabProfile")],
                ["addresses", t("store.account.tabAddresses")],
                ["wishlist", t("store.account.tabWishlist")],
                ["orders", t("store.account.tabOrders")],
              ] as [SignedInTab, string][]
            ).map(([tab, label]) => (
              <button
                key={tab}
                type="button"
                onClick={() => setInTab(tab)}
                className={cn(
                  "shrink-0 rounded-lg px-3 py-2 text-sm font-black transition lg:text-start",
                  inTab === tab
                    ? "bg-[var(--store-surface)] text-[var(--store-primary)] shadow-sm"
                    : "text-[var(--store-text-secondary)]",
                )}
              >
                {label}
                {tab === "wishlist" && wishlist.length > 0 ? ` (${wishlist.length})` : ""}
                {tab === "orders" && history.length > 0 ? ` (${history.length})` : ""}
              </button>
            ))}
          </nav>

          <div>
            {inTab === "profile" ? (
              <form
                className="border border-[var(--store-border)] bg-[var(--store-surface)] p-4"
                style={{ borderRadius: "var(--store-radius)" }}
                onSubmit={(event) => {
                  event.preventDefault();
                  setSaved(false);
                  void updateProfile({
                    name: profileName.trim(),
                    phone: profilePhone.trim(),
                    email: profileEmail.trim() || null,
                  }).then((ok) => setSaved(ok));
                }}
              >
                <h2 className="text-sm font-black uppercase tracking-widest text-[var(--store-text-secondary)]">
                  {t("store.account.tabProfile")}
                </h2>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1 block text-xs font-bold text-[var(--store-text-primary)]">{t("store.checkout.fullName")}</span>
                    <input value={profileName} onChange={(event) => setProfileName(event.target.value)} className={inputClass} />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-bold text-[var(--store-text-primary)]">{t("store.checkout.phone")}</span>
                    <input value={profilePhone} onChange={(event) => setProfilePhone(event.target.value)} className={inputClass} inputMode="tel" />
                  </label>
                  <label className="block sm:col-span-2">
                    <span className="mb-1 block text-xs font-bold text-[var(--store-text-primary)]">{t("store.checkout.email")}</span>
                    <input value={profileEmail} onChange={(event) => setProfileEmail(event.target.value)} className={inputClass} type="email" />
                  </label>
                </div>
                <div className="mt-4 flex items-center gap-3">
                  <button
                    type="submit"
                    disabled={busy || !profileName.trim() || !profilePhone.trim()}
                    className="bg-[var(--store-primary)] px-4 py-2.5 text-sm font-black text-[var(--store-on-primary)] disabled:opacity-40"
                    style={{ borderRadius: "var(--store-radius-button)" }}
                  >
                    {busy ? t("common.loading") : t("common.save")}
                  </button>
                  {saved ? (
                    <span className="text-xs font-bold text-emerald-600">{t("store.account.saved")}</span>
                  ) : null}
                </div>
                <p className="mt-3 text-[11px] leading-relaxed text-[var(--store-text-secondary)]">
                  {t("store.account.profileNote")}
                </p>
              </form>
            ) : null}

            {inTab === "addresses" ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-black uppercase tracking-widest text-[var(--store-text-secondary)]">
                    {t("store.account.tabAddresses")}
                  </h2>
                  <button
                    type="button"
                    onClick={() => setDraft({ ...blankAddress(), full_name: customer?.name ?? "", phone: customer?.phone ?? "" })}
                    className="bg-[var(--store-primary)] px-3 py-2 text-xs font-black text-[var(--store-on-primary)]"
                    style={{ borderRadius: "var(--store-radius-button)" }}
                  >
                    {t("store.account.addAddress")}
                  </button>
                </div>

                {addresses.length === 0 && !draft ? (
                  <p className="border border-dashed border-[var(--store-border)] p-6 text-center text-sm text-[var(--store-text-secondary)]" style={{ borderRadius: "var(--store-radius)" }}>
                    {t("store.account.noAddresses")}
                  </p>
                ) : null}

                {addresses.map((address) => (
                  <article
                    key={address.id}
                    className="border border-[var(--store-border)] bg-[var(--store-surface)] p-4"
                    style={{ borderRadius: "var(--store-radius)" }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-black text-[var(--store-text-primary)]">
                          {address.label || t("store.account.address")}
                          {address.is_default ? (
                            <span className="ms-2 rounded-full bg-[var(--store-primary-soft)] px-2 py-0.5 text-[10px] font-black text-[var(--store-primary)]">
                              {t("store.account.defaultAddress")}
                            </span>
                          ) : null}
                        </p>
                        <p className="mt-1 text-xs text-[var(--store-text-secondary)]">
                          {[address.street, address.area, address.city].filter(Boolean).join("، ")}
                        </p>
                        <p className="text-xs text-[var(--store-text-secondary)]">
                          {[address.building, address.floor, address.apartment].filter(Boolean).join(" · ")}
                        </p>
                        {address.notes ? <p className="mt-1 text-xs text-[var(--store-text-secondary)]">{address.notes}</p> : null}
                      </div>
                      <div className="flex shrink-0 gap-2">
                        {!address.is_default ? (
                          <button
                            type="button"
                            onClick={() => void setDefaultAddress(address.id)}
                            className="text-xs font-bold text-[var(--store-primary)] hover:underline"
                          >
                            {t("store.account.makeDefault")}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => setDraft(address)}
                          className="text-xs font-bold text-[var(--store-text-secondary)] hover:underline"
                        >
                          {t("common.edit")}
                        </button>
                        <button
                          type="button"
                          onClick={() => void removeAddress(address.id)}
                          className="text-xs font-bold text-[var(--store-text-secondary)] hover:text-rose-600"
                        >
                          {t("common.delete")}
                        </button>
                      </div>
                    </div>
                  </article>
                ))}

                {draft ? (
                  <form
                    className="border border-[var(--store-border)] bg-[var(--store-surface)] p-4"
                    style={{ borderRadius: "var(--store-radius)" }}
                    onSubmit={(event) => {
                      event.preventDefault();
                      const next: CustomerAddress = {
                        ...draft,
                        id: draft.id || `addr_${Date.now().toString(36)}`,
                      };
                      void (draft.id ? updateAddress(next) : addAddress(next)).then((ok) => {
                        if (ok) setDraft(null);
                      });
                    }}
                  >
                    <div className="grid gap-3 sm:grid-cols-2">
                      {(
                        [
                          ["label", t("store.account.addressLabel")],
                          ["full_name", t("store.checkout.fullName")],
                          ["phone", t("store.checkout.phone")],
                          ["city", t("store.checkout.city")],
                          ["area", t("store.checkout.area")],
                          ["street", t("store.checkout.street")],
                          ["building", t("store.checkout.building")],
                          ["floor", t("store.checkout.floor")],
                          ["apartment", t("store.checkout.apartment")],
                        ] as [keyof CustomerAddress, string][]
                      ).map(([field, label]) => (
                        <label key={field} className="block">
                          <span className="mb-1 block text-xs font-bold text-[var(--store-text-primary)]">{label}</span>
                          <input
                            value={String(draft[field] ?? "")}
                            onChange={(event) =>
                              setDraft({ ...draft, [field]: event.target.value })
                            }
                            className={inputClass}
                          />
                        </label>
                      ))}
                      <label className="block sm:col-span-2">
                        <span className="mb-1 block text-xs font-bold text-[var(--store-text-primary)]">
                          {t("store.checkout.addressNotes")}
                        </span>
                        <input
                          value={draft.notes ?? ""}
                          onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
                          className={inputClass}
                        />
                      </label>
                    </div>
                    <div className="mt-4 flex items-center gap-3">
                      <button
                        type="submit"
                        disabled={busy || !draft.city.trim() || !draft.street.trim()}
                        className="bg-[var(--store-primary)] px-4 py-2.5 text-sm font-black text-[var(--store-on-primary)] disabled:opacity-40"
                        style={{ borderRadius: "var(--store-radius-button)" }}
                      >
                        {t("common.save")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setDraft(null)}
                        className="text-xs font-bold text-[var(--store-text-secondary)] hover:underline"
                      >
                        {t("common.cancel")}
                      </button>
                    </div>
                  </form>
                ) : null}
              </div>
            ) : null}

            {inTab === "wishlist" ? (
              <div>
                <h2 className="text-sm font-black uppercase tracking-widest text-[var(--store-text-secondary)]">
                  {t("store.account.tabWishlist")}
                </h2>
                {wishlistEntries.length === 0 ? (
                  <p className="mt-3 border border-dashed border-[var(--store-border)] p-6 text-center text-sm text-[var(--store-text-secondary)]" style={{ borderRadius: "var(--store-radius)" }}>
                    {t("store.wishlist.empty")}
                  </p>
                ) : (
                  <ProductGrid className="mt-3 sm:grid-cols-2 lg:grid-cols-3">
                    {wishlistEntries.map((entry) => (
                      <ProductCard key={entry.product.id} entry={entry} />
                    ))}
                  </ProductGrid>
                )}
              </div>
            ) : null}

            {inTab === "orders" ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-black uppercase tracking-widest text-[var(--store-text-secondary)]">
                    {t("store.account.tabOrders")}
                  </h2>
                  <button
                    type="button"
                    onClick={() => void refreshHistory()}
                    className="text-xs font-bold text-[var(--store-primary)] hover:underline"
                  >
                    {historyLoading ? t("common.loading") : t("common.refresh")}
                  </button>
                </div>

                {history.length === 0 ? (
                  <p className="border border-dashed border-[var(--store-border)] p-6 text-center text-sm text-[var(--store-text-secondary)]" style={{ borderRadius: "var(--store-radius)" }}>
                    {historyLoading ? t("common.loading") : t("store.account.noOrders")}
                  </p>
                ) : null}

                {history.map((order) => (
                  <article
                    key={order.id}
                    className="border border-[var(--store-border)] bg-[var(--store-surface)] p-4"
                    style={{ borderRadius: "var(--store-radius)" }}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-black tabular-nums text-[var(--store-text-primary)]">{order.order_number}</p>
                        <p className="text-xs text-[var(--store-text-secondary)]">
                          {new Date(order.created_at).toLocaleDateString(pick("ar-EG", "en-GB"))} ·{" "}
                          {t("store.cart.itemCount", { count: order.items.reduce((sum, item) => sum + item.quantity, 0) })}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <OrderStatusPill status={order.status} />
                        <PaymentStatusPill status={order.payment_status} />
                        <Money value={order.total} className="text-sm font-black text-[var(--store-text-primary)]" />
                      </div>
                    </div>

                    <p className="mt-2 line-clamp-2 text-xs text-[var(--store-text-secondary)]">
                      {order.items.map((item) => pick(item.name_ar, item.name_en)).join("، ")}
                    </p>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <Link
                        to={`/store/track?order=${encodeURIComponent(order.order_number)}&phone=${encodeURIComponent(order.customer_phone)}`}
                        className="rounded-lg border border-[var(--store-border)] px-3 py-1.5 text-xs font-black text-[var(--store-text-primary)]"
                      >
                        {t("store.account.viewOrder")}
                      </Link>
                      {order.status !== "cancelled" ? (
                        <button
                          type="button"
                          onClick={() => void reorder(order)}
                          className="rounded-lg bg-[var(--store-primary)] px-3 py-1.5 text-xs font-black text-[var(--store-on-primary)]"
                        >
                          {t("store.account.reorder")}
                        </button>
                      ) : null}
                    </div>
                    {reordered === order.order_number ? (
                      <p className="mt-2 text-xs font-bold text-emerald-600">{t("store.account.reordered")}</p>
                    ) : null}
                  </article>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
