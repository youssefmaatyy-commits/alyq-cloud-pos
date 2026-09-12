/**
 * One image slot in the website builder.
 *
 * Every place an admin can put a picture — logo, favicon, hero slide, section
 * background, InstaPay QR — uses this, so the rules are the rules everywhere:
 * the catalogue's own validation (MIME whitelist, 5 MB), the `website/` storage
 * prefix, a preview of exactly what the storefront will show, and a way to paste
 * a URL instead of uploading one.
 *
 * Upload failures name the field rather than raising a toast: a builder with
 * twelve slots needs to say *which* slot refused the file.
 */
import { useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Button, TextInput } from "@/components/ui";
import { uploadStoreImage } from "../../services/imageUpload";

interface Props {
  label: string;
  hint?: string;
  value: string | null;
  onChange: (url: string | null) => void;
  /** Preview shape; defaults to a wide banner. */
  previewClass?: string;
  disabled?: boolean;
}

export function SettingsImageField({
  label,
  hint,
  value,
  onChange,
  previewClass = "h-24 w-full",
  disabled = false,
}: Props) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [urlDraft, setUrlDraft] = useState("");

  const upload = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const url = await uploadStoreImage(file, "website");
      onChange(url);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (message.startsWith("IMAGE_TYPE_NOT_ALLOWED")) setError(t("online.images.typeError"));
      else if (message.startsWith("IMAGE_TOO_LARGE")) setError(t("online.images.sizeError"));
      else setError(t("online.images.uploadError"));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <p className="text-xs font-bold text-slate-800">{label}</p>
      {hint ? <p className="mt-0.5 text-[11px] font-medium text-slate-500">{hint}</p> : null}

      <div
        className={`mt-2 grid place-items-center overflow-hidden rounded-lg border border-dashed border-slate-300 bg-slate-50 ${previewClass}`}
      >
        {value ? (
          <img
            src={value}
            alt={label}
            className="h-full w-full object-contain"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <span className="text-[11px] font-semibold text-slate-400">{t("online.images.noImage")}</span>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          disabled={disabled || busy}
          onChange={(event) => void upload(event.target.files?.[0] ?? null)}
        />
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          {value ? t("online.images.replace") : t("online.images.upload")}
        </Button>
        {value ? (
          <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={() => onChange(null)}>
            {t("online.images.remove")}
          </Button>
        ) : null}
      </div>

      <div className="mt-2 flex gap-2">
        <TextInput
          value={urlDraft}
          onChange={(event) => setUrlDraft(event.target.value)}
          placeholder={t("online.images.urlPlaceholder")}
          className="h-8 text-xs"
          disabled={disabled}
          aria-label={t("online.images.urlLabel")}
        />
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || !urlDraft.trim()}
          onClick={() => {
            onChange(urlDraft.trim());
            setUrlDraft("");
          }}
        >
          {t("online.images.useUrl")}
        </Button>
      </div>

      {error ? <p className="mt-2 text-[11px] font-bold text-rose-600">{error}</p> : null}
    </div>
  );
}
