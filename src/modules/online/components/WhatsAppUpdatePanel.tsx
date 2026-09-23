/**
 * Send a WhatsApp order update — a deep link, not an API delivery.
 *
 * The status buttons elsewhere on the order stay the only thing that moves
 * the order. This panel never calls them. The audit row, if the trail accepts
 * it, says `initiated`.
 */
import { useEffect, useMemo, useState } from "react";
import { canAct } from "@/lib/permissions/enforce";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { recordAudit } from "@/modules/audit/services/auditService";
import { Badge, Button } from "@/components/ui";
import { getWebsiteRepository } from "../data";
import { resolveSettings } from "../services/settingsDefaults";
import {
  customerTrackingLink,
  defaultWhatsAppUpdates,
  orderGovernorateLabel,
  planWhatsAppUpdate,
  suggestedTemplateKey,
  templateText,
  trackingOriginFromLocation,
  whatsAppPlaceholderValues,
  WHATSAPP_TEMPLATE_KEYS,
} from "../services/whatsapp";
import type { OnlineOrder, WhatsAppTemplateKey, WhatsAppUpdatesSettings } from "../types";

export function useWhatsAppUpdates(): WhatsAppUpdatesSettings {
  const [settings, setSettings] = useState<WhatsAppUpdatesSettings>(() => defaultWhatsAppUpdates());
  useEffect(() => {
    let cancelled = false;
    getWebsiteRepository()
      .getSettings()
      .then((loaded) => {
        if (!cancelled) setSettings(resolveSettings(loaded).whatsapp_updates);
      })
      .catch(() => {
        if (!cancelled) setSettings(defaultWhatsAppUpdates());
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return settings;
}

export function WhatsAppUpdatePanel({
  order,
  templates,
  preferredKey = null,
  offerNote = false,
  onDismissOffer,
}: {
  order: OnlineOrder;
  templates: WhatsAppUpdatesSettings;
  /** After a status change, preselect the matching template. Does not send. */
  preferredKey?: WhatsAppTemplateKey | null;
  offerNote?: boolean;
  onDismissOffer?: () => void;
}) {
  const { t, lang, money } = useI18n();
  const canSend = canAct("manage_online_orders");
  const suggested = suggestedTemplateKey(order);
  const [language, setLanguage] = useState<"ar" | "en">(lang === "ar" ? "ar" : "en");
  const [templateKey, setTemplateKey] = useState<WhatsAppTemplateKey>(suggested ?? "approved");

  useEffect(() => {
    if (preferredKey) setTemplateKey(preferredKey);
  }, [preferredKey]);

  const origin = useMemo(() => {
    if (typeof window === "undefined") return "";
    return trackingOriginFromLocation(window.location);
  }, []);

  const values = useMemo(
    () =>
      whatsAppPlaceholderValues({
        customerName: order.customer_name,
        orderNumber: order.order_number,
        orderTotalLabel: money(order.total),
        governorate: orderGovernorateLabel(order, language),
        trackingLink: origin ? customerTrackingLink(origin, order.order_number, order.customer_phone) : "",
        paymentMethodLabel: t(`pos.payment.${order.payment_method}`),
        deliveryMethodLabel: t(`online.deliveryType.${order.delivery_type}`),
      }),
    [order, language, money, origin, t],
  );

  const plan = planWhatsAppUpdate({
    phone: order.customer_phone,
    template: templateText(templates, templateKey, language),
    values,
    templateKey,
    language,
  });

  const recordInitiated = () => {
    if (!plan.ok || !canSend) return;
    void recordAudit({
      action: "whatsapp.initiated",
      entity: "online_order",
      entity_id: order.id,
      entity_label: order.order_number,
      details: {
        template: plan.templateKey,
        language: plan.language,
        outcome: "initiated",
        order_number: order.order_number,
      },
    });
  };

  return (
    <section className="rounded-xl border border-stone-200 bg-[#faf7f2] p-3" data-testid="whatsapp-update-panel">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wide text-stone-500">{t("whatsapp.update.title")}</p>
          <p className="mt-1 text-xs font-medium text-stone-600">{t("whatsapp.update.initiatedNote")}</p>
        </div>
        {suggested ? (
          <Badge tone="neutral">{t(`whatsapp.template.${suggested}`)}</Badge>
        ) : null}
      </div>

      {offerNote ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#e6d7bc] bg-white px-3 py-2 text-xs font-semibold text-stone-800">
          <span>{t("whatsapp.update.offer")}</span>
          {onDismissOffer ? (
            <button type="button" className="text-[#9a7a49] hover:underline" onClick={onDismissOffer}>
              {t("whatsapp.update.dismiss")}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-bold text-stone-700">
          {t("whatsapp.update.template")}
          <select
            className="mt-1 h-10 w-full rounded-xl border border-stone-200 bg-white px-3 text-sm font-semibold text-stone-900"
            value={templateKey}
            onChange={(event) => setTemplateKey(event.target.value as WhatsAppTemplateKey)}
            data-testid="whatsapp-template-select"
          >
            {WHATSAPP_TEMPLATE_KEYS.map((key) => (
              <option key={key} value={key}>
                {t(`whatsapp.template.${key}`)}
              </option>
            ))}
          </select>
        </label>
        <div className="block text-xs font-bold text-stone-700">
          {t("whatsapp.update.language")}
          <div className="mt-1 flex gap-1 rounded-xl bg-white p-1 ring-1 ring-stone-200" role="group" aria-label={t("whatsapp.update.language")}>
            {(["ar", "en"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setLanguage(option)}
                aria-pressed={language === option}
                className={`h-8 flex-1 rounded-lg text-xs font-bold ${
                  language === option ? "bg-stone-900 text-white" : "text-stone-600 hover:text-stone-900"
                }`}
              >
                {option === "ar" ? t("whatsapp.settings.ar") : t("whatsapp.settings.en")}
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className="mt-3 text-[11px] font-bold uppercase tracking-wide text-stone-500">{t("whatsapp.update.preview")}</p>
      <p
        className="mt-1 whitespace-pre-wrap rounded-xl bg-white px-3 py-2 text-sm leading-relaxed text-stone-800 ring-1 ring-stone-200"
        dir={language === "ar" ? "rtl" : "ltr"}
        data-testid="whatsapp-preview"
      >
        {plan.ok ? plan.message : t("whatsapp.update.invalidPhone")}
      </p>

      {!plan.ok ? (
        <p className="mt-2 text-xs font-semibold text-rose-800" role="alert" data-testid="whatsapp-invalid-phone">
          {t("whatsapp.update.invalidPhone")}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {plan.ok && canSend ? (
          <a
            href={plan.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={recordInitiated}
            data-testid="whatsapp-update-send"
            data-outcome="initiated"
            className="alyq-btn-primary inline-flex h-10 items-center rounded-xl px-4 text-sm"
          >
            {t("whatsapp.update.send")}
          </a>
        ) : (
          <Button variant="secondary" disabled>
            {t("whatsapp.update.send")}
          </Button>
        )}
        {!canSend ? <p className="text-xs font-semibold text-stone-600">{t("whatsapp.update.needPermission")}</p> : null}
      </div>
      <p className="mt-2 text-[11px] font-medium text-stone-500">{t("whatsapp.update.noStatusChange")}</p>
    </section>
  );
}
