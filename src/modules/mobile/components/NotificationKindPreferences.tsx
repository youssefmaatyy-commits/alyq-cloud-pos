import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import {
  DEFAULT_NOTIFICATION_KIND_PREFERENCES,
  loadNotificationKindPreferences,
  notificationPreferencesBackendAvailable,
  saveNotificationKindPreferences,
  type NotificationKindPreferences as Preferences,
} from "../services/notificationPreferences";
import { MobileCard } from "./MobilePrimitives";

const ROWS = [
  {
    key: "onlineOrders" as const,
    testId: "notification-pref-online-orders",
    en: "Online orders & payment review",
    ar: "الطلبات الإلكترونية ومراجعات الدفع",
  },
  {
    key: "criticalStock" as const,
    testId: "notification-pref-critical-stock",
    en: "Critical stock",
    ar: "المخزون الحرج",
  },
  {
    key: "syncFailures" as const,
    testId: "notification-pref-sync-failures",
    en: "Unresolved sync conflicts",
    ar: "تعارضات المزامنة غير المحلولة",
  },
];

/** Account-wide Push choices. Authorized in-app history remains independent. */
export function NotificationKindPreferences() {
  const { lang } = useI18n();
  const ar = lang === "ar";
  const [available] = useState(() => notificationPreferencesBackendAvailable());
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_NOTIFICATION_KIND_PREFERENCES);
  const [loading, setLoading] = useState(available);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!available) return;
    let active = true;
    void loadNotificationKindPreferences()
      .then((value) => {
        if (active) setPreferences(value);
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [available]);

  if (!available) return null;

  const update = async (key: keyof Preferences, checked: boolean) => {
    if (saving || loading) return;
    const previous = preferences;
    const next = { ...preferences, [key]: checked };
    setPreferences(next);
    setSaving(true);
    setError(false);
    try {
      setPreferences(await saveNotificationKindPreferences(next));
    } catch {
      setPreferences(previous);
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <MobileCard className="mobile-push-card" >
      <div data-testid="notification-kind-preferences" className="space-y-3">
        <div>
          <strong>{ar ? "أنواع إشعارات الجهاز" : "Device notification types"}</strong>
          <p className="mobile-muted">
            {ar
              ? "تسري هذه الاختيارات على Push لكل أجهزة حسابك. يبقى مركز الإشعارات الداخلي محتفظًا بالتنبيهات المخوّلة دائمًا."
              : "These choices control Push on every device for your account. Notification Center always retains authorized alerts."}
          </p>
        </div>
        {ROWS.map((row) => (
          <label key={row.key} className="mobile-row gap-3" data-testid={row.testId}>
            <span className="text-sm font-semibold">{ar ? row.ar : row.en}</span>
            <input
              type="checkbox"
              className="h-5 w-5 shrink-0 accent-[#172033]"
              checked={preferences[row.key]}
              disabled={loading || saving}
              onChange={(event) => void update(row.key, event.target.checked)}
              aria-label={ar ? row.ar : row.en}
            />
          </label>
        ))}
        <p className="mobile-muted" aria-live="polite">
          {error
            ? ar ? "تعذر حفظ التفضيلات. تمت استعادة الاختيار السابق." : "Preferences could not be saved. The previous choice was restored."
            : saving
              ? ar ? "جارٍ الحفظ…" : "Saving…"
              : ar ? "لن تصل التنبيهات القديمة المعلّقة لنوع أوقفته عند إعادة تفعيله." : "Queued alerts for a disabled type will not arrive later when you re-enable it."}
        </p>
      </div>
    </MobileCard>
  );
}
