/**
 * Edit the WhatsApp order-update templates inside Website settings.
 *
 * Reset restores the shipped sentence for that status. Nothing here sends a
 * message — preview uses labelled sample values, not a real customer.
 */
import { useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Button, Card } from "@/components/ui";
import {
  WHATSAPP_TEMPLATE_MAX,
  clampWhatsAppTemplate,
  defaultWhatsAppUpdates,
  fillWhatsAppTemplate,
  templateText,
} from "../../services/whatsapp";
import { WHATSAPP_PLACEHOLDERS, WHATSAPP_TEMPLATE_KEYS, type WebsiteSettings, type WhatsAppTemplateKey } from "../../types";

const SAMPLE = {
  customer_name: "Ahmed",
  order_number: "WEB-000001",
  order_total: "1,500.00 EGP",
  delivery_governorate: "Ismailia",
  tracking_link: "https://shop.example/#/store/track?order=WEB-000001",
  payment_method: "Cash on delivery",
  delivery_method: "Delivery",
} as const;

export function WhatsAppTemplatesPanel({
  draft,
  patch,
}: {
  draft: WebsiteSettings;
  patch: (change: (current: WebsiteSettings) => WebsiteSettings) => void;
}) {
  const { t } = useI18n();
  const [language, setLanguage] = useState<"ar" | "en">("ar");
  const [key, setKey] = useState<WhatsAppTemplateKey>("approved");
  const templates = draft.whatsapp_updates;
  const text = templateText(templates, key, language);
  const preview = useMemo(() => fillWhatsAppTemplate(text, SAMPLE), [text]);

  const write = (languageKey: "ar" | "en", value: string) => {
    patch((current) => ({
      ...current,
      whatsapp_updates: {
        templates: {
          ...current.whatsapp_updates.templates,
          [key]: {
            ...current.whatsapp_updates.templates[key],
            [languageKey]: clampWhatsAppTemplate(value),
          },
        },
      },
    }));
  };

  const resetOne = () => {
    const shipped = defaultWhatsAppUpdates().templates[key];
    patch((current) => ({
      ...current,
      whatsapp_updates: {
        templates: { ...current.whatsapp_updates.templates, [key]: { ...shipped } },
      },
    }));
  };

  const resetAll = () => {
    patch((current) => ({ ...current, whatsapp_updates: defaultWhatsAppUpdates() }));
  };

  return (
    <Card className="space-y-4" data-testid="whatsapp-templates-settings">
      <div>
        <h2 className="text-sm font-bold text-slate-900">{t("whatsapp.settings.title")}</h2>
        <p className="mt-1 text-xs font-medium leading-relaxed text-slate-600">{t("whatsapp.settings.hint")}</p>
      </div>

      <div className="flex flex-wrap gap-1">
        {WHATSAPP_TEMPLATE_KEYS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            onClick={() => setKey(candidate)}
            className={`rounded-full px-3 py-1 text-xs font-bold ring-1 ${
              candidate === key
                ? "bg-stone-900 text-white ring-stone-900"
                : "bg-white text-slate-700 ring-slate-200 hover:bg-slate-50"
            }`}
          >
            {t(`whatsapp.template.${candidate}`)}
          </button>
        ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <label className="block text-xs font-bold text-slate-700">
          {t("whatsapp.settings.ar")}
          <textarea
            value={templates.templates[key].ar}
            maxLength={WHATSAPP_TEMPLATE_MAX}
            rows={5}
            dir="rtl"
            onChange={(event) => write("ar", event.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm leading-relaxed text-slate-900"
          />
        </label>
        <label className="block text-xs font-bold text-slate-700">
          {t("whatsapp.settings.en")}
          <textarea
            value={templates.templates[key].en}
            maxLength={WHATSAPP_TEMPLATE_MAX}
            rows={5}
            dir="ltr"
            onChange={(event) => write("en", event.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm leading-relaxed text-slate-900"
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={resetOne}>
          {t("whatsapp.settings.reset")}
        </Button>
        <Button type="button" variant="secondary" onClick={resetAll}>
          {t("whatsapp.settings.resetAll")}
        </Button>
      </div>

      <div>
        <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{t("whatsapp.settings.sample")}</p>
        <p className="mt-1 whitespace-pre-wrap rounded-xl bg-[#faf7f2] px-3 py-2 text-sm leading-relaxed text-slate-800" dir={language === "ar" ? "rtl" : "ltr"} data-testid="whatsapp-template-preview">
          {preview}
        </p>
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {WHATSAPP_PLACEHOLDERS.map((placeholder) => (
            <li key={placeholder} className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[10px] font-semibold text-slate-700" dir="ltr">
              {`{{${placeholder}}}`}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex gap-1" role="group" aria-label={t("whatsapp.update.language")}>
        {(["ar", "en"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setLanguage(option)}
            className={`rounded-lg px-3 py-1 text-xs font-bold ${language === option ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200" : "text-slate-600"}`}
          >
            {option === "ar" ? t("whatsapp.settings.previewAr") : t("whatsapp.settings.previewEn")}
          </button>
        ))}
      </div>
    </Card>
  );
}
