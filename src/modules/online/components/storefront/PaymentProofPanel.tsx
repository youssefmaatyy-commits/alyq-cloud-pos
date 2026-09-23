/**
 * The InstaPay proof panel.
 *
 * Used twice — straight after checkout, when the transfer details are still on
 * screen, and from order tracking, when a customer comes back to pay later or to
 * re-send proof an employee rejected.
 *
 * It never says "paid". Uploading proof moves the order to *verification
 * required*, which is a queue item for a human; the wording here is deliberate so
 * a customer does not assume the shop has the money, and so the shop is not
 * obliged to ship on a screenshot.
 */
import { useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { cn } from "@/utils/cn";
import { useStorefront } from "../../hooks/StorefrontProvider";
import { toOnlineError } from "../../data/repository";
import { externalHref } from "../../services/settingsDefaults";
import { FieldNote, Money } from "./StorePrimitives";

/** A customer should not be able to upload a 40 MB camera photo by accident. */
const MAX_PROOF_BYTES = 8 * 1024 * 1024;

interface Props {
  orderNumber: string;
  phone: string;
  total?: number;
  /**
   * The customer already sent a proof once — offer to replace it rather than send
   * again. This is *not* the payment status: an InstaPay order starts life owed a
   * verification, long before anybody has transferred anything, and telling a
   * customer "proof sent" when they have not sent one would be a lie that costs
   * the shop an unpaid order.
   */
  submitted?: boolean;
  /** The reference already on the order, shown back and offered for editing. */
  storedReference?: string | null;
}

export function PaymentProofPanel({
  orderNumber,
  phone,
  total,
  submitted = false,
  storedReference = null,
}: Props) {
  const { t, pick } = useI18n();
  const { settings, uploadProofImage, submitPaymentProof } = useStorefront();

  const [reference, setReference] = useState(storedReference ?? "");
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<"upload" | "submit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(submitted);
  const inputRef = useRef<HTMLInputElement>(null);

  const instapay = settings.delivery.instapay_enabled;
  // Same policy as the checkout: a configured link is admin-typed text bound
  // for a public `href` — only an absolute http(s) URL is rendered.
  const instapayPayHref = externalHref(settings.social.instapay_link);
  const instapayInstructions = pick(
    settings.delivery.instapay_instructions_ar,
    settings.delivery.instapay_instructions_en,
  ).trim();
  const canSubmit = Boolean(reference.trim()) && (Boolean(file) || done);

  const choose = (picked: File | null) => {
    setError(null);
    if (!picked) {
      setFile(null);
      setFileName("");
      setPreview(null);
      return;
    }
    if (picked.size > MAX_PROOF_BYTES) {
      setError(t("store.proof.tooLarge"));
      setFile(null);
      setFileName("");
      setPreview(null);
      return;
    }
    if (!/^image\//.test(picked.type)) {
      setError(t("store.proof.imageOnly"));
      return;
    }
    setFile(picked);
    setFileName(picked.name);
    setPreview(URL.createObjectURL(picked));
  };

  const send = async () => {
    setBusy(file ? "upload" : "submit");
    setError(null);
    try {
      // The image goes first: the submission stores its URL, so an upload that
      // fails must fail before anything is written about the payment.
      const proofUrl = file ? await uploadProofImage(file) : "";
      setBusy("submit");
      await submitPaymentProof({
        order_number: orderNumber,
        customer_phone: phone,
        payment_reference: reference.trim(),
        payment_proof_url: proofUrl || null,
      });
      setDone(true);
    } catch (caught) {
      setError(t(`store.error.${toOnlineError(caught).code}` as never));
    } finally {
      setBusy(null);
    }
  };

  if (done) {
    return (
      <div
        className="border border-emerald-200 bg-emerald-50 p-4"
        style={{ borderRadius: "var(--store-radius)" }}
        role="status"
      >
        <p className="text-sm font-black text-emerald-800">{t("store.proof.sent")}</p>
        <p className="mt-1 text-xs leading-relaxed text-emerald-700">{t("store.proof.sentHint")}</p>
        <p className="mt-2 text-xs font-bold text-emerald-800">
          {t("store.proof.reference")}: {reference || "—"}
        </p>
        <button
          type="button"
          onClick={() => {
            setDone(false);
            setReference("");
            setFile(null);
            setFileName("");
            setPreview(null);
          }}
          className="mt-3 text-xs font-bold text-emerald-700 underline"
        >
          {t("store.proof.replace")}
        </button>
      </div>
    );
  }

  return (
    <div className="border border-[var(--store-border)] bg-[var(--store-surface)] p-4" style={{ borderRadius: "var(--store-radius)" }}>
      <h2 className="text-sm font-black uppercase tracking-widest text-[var(--store-text-secondary)]">
        {t("store.proof.title")}
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-[var(--store-text-secondary)]">{t("store.proof.hint")}</p>

      {typeof total === "number" ? (
        <p className="mt-3 flex items-baseline gap-2 rounded-lg bg-[var(--store-primary-soft)] px-3 py-2">
          <span className="text-xs font-bold text-[var(--store-text-secondary)]">{t("store.proof.amountToSend")}</span>
          <Money value={total} className="text-base font-black text-[var(--store-primary)]" />
        </p>
      ) : null}

      {instapay ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]">
          <div className="text-xs">
            {settings.social.instapay_holder ? (
              <p className="font-semibold text-[var(--store-text-secondary)]">
                {t("store.checkout.instapayHolder")}: {settings.social.instapay_holder}
              </p>
            ) : null}
            {settings.social.instapay_account ? (
              <p className="font-black text-[var(--store-text-primary)]">{settings.social.instapay_account}</p>
            ) : null}
            {instapayInstructions ? (
              <p className="mt-2 whitespace-pre-line leading-relaxed text-[var(--store-text-secondary)]">
                {instapayInstructions}
              </p>
            ) : (
              <ol className="mt-2 list-decimal space-y-1 ps-4 text-[var(--store-text-secondary)]">
                <li>{t("store.proof.step1")}</li>
                <li>{t("store.proof.step2")}</li>
                <li>{t("store.proof.step3")}</li>
              </ol>
            )}
            {instapayPayHref ? (
              <a
                href={instapayPayHref}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-block bg-[var(--store-primary)] px-3 py-1.5 text-xs font-black text-[var(--store-on-primary)]"
                style={{ borderRadius: "var(--store-radius-button)" }}
              >
                {t("store.checkout.openInstapay")}
              </a>
            ) : null}
          </div>
          {settings.social.instapay_qr_url ? (
            <img
              src={settings.social.instapay_qr_url}
              alt={t("store.checkout.instapayQr")}
              loading="lazy"
              decoding="async"
              className="h-32 w-32 justify-self-start rounded-lg border border-[var(--store-border)] bg-white object-contain p-1 sm:justify-self-end"
            />
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 grid gap-3">
        <label className="block">
          <span className="mb-1 block text-xs font-bold text-[var(--store-text-primary)]">{t("store.proof.reference")}</span>
          <input
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            className="w-full rounded-lg border border-[var(--store-border)] bg-[var(--store-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--store-primary)]"
            placeholder={t("store.proof.referencePlaceholder")}
            autoComplete="off"
          />
          <FieldNote>{t("store.proof.referenceHint")}</FieldNote>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-bold text-[var(--store-text-primary)]">{t("store.proof.image")}</span>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            onChange={(event) => choose(event.target.files?.[0] ?? null)}
            className="w-full text-xs text-[var(--store-text-secondary)] file:me-3 file:rounded-lg file:border-0 file:bg-[var(--store-primary-soft)] file:px-3 file:py-2 file:text-xs file:font-black file:text-[var(--store-primary)]"
          />
          {fileName ? <FieldNote tone="muted">{fileName}</FieldNote> : null}
        </label>

        {preview ? (
          <img
            src={preview}
            alt=""
            className="h-40 w-auto max-w-full rounded-lg border border-[var(--store-border)] object-contain"
          />
        ) : null}

        {error ? <p className="text-xs font-bold text-rose-600">{error}</p> : null}

        <button
          type="button"
          disabled={!canSubmit || busy !== null}
          onClick={() => void send()}
          className={cn(
            "w-full bg-[var(--store-primary)] px-4 py-3 text-sm font-black text-[var(--store-on-primary)] transition hover:bg-[var(--store-primary-hover)]",
            "disabled:cursor-not-allowed disabled:bg-[var(--store-border)] disabled:text-[var(--store-text-secondary)]",
          )}
          style={{ borderRadius: "var(--store-radius-button)" }}
        >
          {busy === "upload"
            ? t("store.proof.uploading")
            : busy === "submit"
              ? t("store.proof.submitting")
              : t("store.proof.submit")}
        </button>
        <p className="text-[11px] leading-relaxed text-[var(--store-text-secondary)]">{t("store.proof.neverAutomatic")}</p>
      </div>

      <p className="mt-3 text-[11px] text-[var(--store-text-secondary)]">
        {t("store.proof.orderRef")}: <span className="font-black">{orderNumber}</span>
        {phone ? ` · ${phone}` : ""}
      </p>
    </div>
  );
}
