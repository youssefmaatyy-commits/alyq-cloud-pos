import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useBranch } from "@/lib/branch";
import { MobileBadge, MobileCard, MobilePage, MobileState } from "../components/MobilePrimitives";
import { NotificationKindPreferences } from "../components/NotificationKindPreferences";
import { useMobile } from "../MobileContext";
import type { PushConfigurationState, PushDiagnostics, PushPermissionState, PushServiceWorkerState, PushSubscriptionState } from "../services/mobilePush";
import { currentWebPushPlatform, type WebPushPlatform } from "../services/webPush";
import {
  listMobileNotifications,
  markAllMobileNotificationsRead,
  markMobileNotificationRead,
  resolveMobileNotificationRoute,
  type MobileNotification,
} from "../services/notificationCenter";

interface PushCopyOptions {
  platform?: WebPushPlatform;
  native?: boolean;
}

function deniedPermissionDetail(lang: "en" | "ar", options: PushCopyOptions): string {
  const ar = lang === "ar";
  const platform = options.platform ?? currentWebPushPlatform();
  if (platform === "windows") return ar
    ? "في Chrome على Windows: ⋮ ← الإعدادات ← الخصوصية والأمان ← إعدادات الموقع ← الإشعارات، واسمح لموقع ALYQ الحالي. فعّل Chrome أيضًا من إعدادات Windows ← النظام ← الإشعارات. يظل مركز الإشعارات متاحًا."
    : "In Chrome on Windows: ⋮ → Settings → Privacy and security → Site settings → Notifications, and allow this exact ALYQ site. Also enable Chrome in Windows Settings → System → Notifications. Notification Center remains available.";
  if (platform === "android") return options.native
    ? (ar ? "في Android: الإعدادات ← التطبيقات ← ALYQ ← الإشعارات، ثم فعّل السماح بالإشعارات. يظل مركز الإشعارات متاحًا."
      : "On Android: Settings → Apps → ALYQ → Notifications, then allow notifications. Notification Center remains available.")
    : (ar ? "في Android: الإعدادات ← التطبيقات ← Chrome ← الإشعارات، ثم اسمح لموقع ALYQ الحالي من إعدادات المواقع في Chrome. يظل مركز الإشعارات متاحًا."
      : "On Android: Settings → Apps → Chrome → Notifications, then allow this exact ALYQ site in Chrome's site settings. Notification Center remains available.");
  if (platform === "ios") return ar
    ? "في iPhone: الإعدادات ← الإشعارات ← ALYQ، ثم فعّل السماح بالإشعارات. يظل مركز الإشعارات متاحًا."
    : "On iPhone: Settings → Notifications → ALYQ, then enable Allow Notifications. Notification Center remains available.";
  if (platform === "macos") return ar
    ? "اسمح لموقع ALYQ الحالي من إعدادات المواقع في Chrome، وفعّل Chrome من إعدادات macOS ← الإشعارات. يظل مركز الإشعارات متاحًا."
    : "Allow this exact ALYQ site in Chrome's site settings, and enable Chrome in macOS Settings → Notifications. Notification Center remains available.";
  return ar
    ? "اسمح لموقع ALYQ الحالي في إعدادات المتصفح، وفعّل إشعارات المتصفح في إعدادات النظام. يظل مركز الإشعارات متاحًا."
    : "Allow this exact ALYQ site in browser settings, and enable browser notifications in system settings. Notification Center remains available.";
}

export function permissionStatusLabel(state: PushPermissionState, lang: "en" | "ar"): string {
  const ar = lang === "ar";
  if (state === "granted") return ar ? "مسموح" : "Granted";
  if (state === "denied") return ar ? "مرفوض" : "Denied";
  if (state === "default") return ar ? "لم يُطلب" : "Default";
  return ar ? "غير مدعوم" : "Unsupported";
}

export function subscriptionStatusLabel(state: PushSubscriptionState, lang: "en" | "ar"): string {
  const ar = lang === "ar";
  if (state === "registered") return ar ? "نشط" : "Registered";
  if (state === "registering") return ar ? "جارٍ التسجيل" : "Registering";
  if (state === "error") return ar ? "خطأ في الاشتراك" : "Subscription error";
  if (state === "not_subscribed") return ar ? "غير مشترك" : "Not subscribed";
  return ar ? "غير مدعوم" : "Unsupported";
}

export function serviceWorkerStatusLabel(state: PushServiceWorkerState, lang: "en" | "ar"): string {
  const ar = lang === "ar";
  if (state === "registered") return ar ? "مسجّل" : "Registered";
  if (state === "registering") return ar ? "جارٍ التسجيل" : "Registering";
  if (state === "error") return ar ? "خطأ في Service Worker" : "Service Worker error";
  if (state === "not_checked") return ar ? "لم يُفحص" : "Not checked";
  if (state === "not_applicable") return ar ? "غير منطبق" : "Not applicable";
  return ar ? "غير مدعوم" : "Unsupported";
}

export function webPushConfigurationStatusLabel(state: PushConfigurationState, lang: "en" | "ar"): string {
  const ar = lang === "ar";
  if (state === "configured") return ar ? "مكوّن" : "Configured";
  if (state === "missing") return ar ? "المفتاح العام مفقود" : "Public key missing";
  if (state === "invalid") return ar ? "المفتاح العام غير صالح" : "Invalid public key";
  if (state === "unavailable") return ar ? "تعذر فحص الإعداد العام" : "Public configuration unavailable";
  if (state === "not_checked") return ar ? "لم يُفحص" : "Not checked";
  return ar ? "غير منطبق" : "Not applicable";
}

export function PushDiagnosticsRows({ diagnostics, lang }: { diagnostics: PushDiagnostics; lang: "en" | "ar" }) {
  const ar = lang === "ar";
  return <div className="space-y-2 pt-3" data-testid="push-diagnostics">
    <div className="mobile-row" data-testid="push-permission-status">
      <span className="mobile-muted">{ar ? "إذن المتصفح" : "Browser permission"}</span>
      <MobileBadge tone={diagnostics.permission === "granted" ? "success" : diagnostics.permission === "denied" ? "warning" : "neutral"}>
        {permissionStatusLabel(diagnostics.permission, lang)}
      </MobileBadge>
    </div>
    <div className="mobile-row" data-testid="push-service-worker-status">
      <span className="mobile-muted">Service Worker</span>
      <MobileBadge tone={diagnostics.serviceWorker === "registered" ? "success" : diagnostics.serviceWorker === "registering" ? "info" : diagnostics.serviceWorker === "error" ? "warning" : "neutral"}>
        {serviceWorkerStatusLabel(diagnostics.serviceWorker, lang)}
      </MobileBadge>
    </div>
    <div className="mobile-row" data-testid="push-subscription-status">
      <span className="mobile-muted">{ar ? "اشتراك هذا الجهاز" : "This device's subscription"}</span>
      <MobileBadge tone={diagnostics.subscription === "registered" ? "success" : diagnostics.subscription === "registering" ? "info" : diagnostics.subscription === "error" ? "warning" : "neutral"}>
        {subscriptionStatusLabel(diagnostics.subscription, lang)}
      </MobileBadge>
    </div>
    <div className="mobile-row" data-testid="push-configuration-status">
      <span className="mobile-muted">{ar ? "إعداد Web Push العام" : "Public Web Push configuration"}</span>
      <MobileBadge tone={diagnostics.configuration === "configured" ? "success" : diagnostics.configuration === "missing" || diagnostics.configuration === "invalid" || diagnostics.configuration === "unavailable" ? "warning" : "neutral"}>
        {webPushConfigurationStatusLabel(diagnostics.configuration, lang)}
      </MobileBadge>
    </div>
    <p className="mobile-muted">{ar
      ? "مركز الإشعارات الداخلي يعمل بشكل مستقل حتى لو كانت إشعارات الجهاز مرفوضة أو غير مدعومة."
      : "The internal Notification Center works independently even when device notifications are denied or unsupported."}</p>
  </div>;
}

export function pushStateCopy(state: ReturnType<typeof useMobile>["pushState"], lang: "en" | "ar", options: PushCopyOptions = {}) {
  const ar = lang === "ar";
  if (state === "install_required") return {
    title: ar ? "ثبّت ALYQ على الشاشة الرئيسية لتفعيل الإشعارات" : "Install ALYQ on your Home Screen to enable notifications",
    detail: ar ? "في Safari اضغط مشاركة، ثم إضافة إلى الشاشة الرئيسية، وافتح ALYQ من الأيقونة." : "In Safari, tap Share, then Add to Home Screen, and open ALYQ from its icon.",
    tone: "neutral" as const,
  };
  if (state === "not_requested") return {
    title: ar ? "الإشعارات متاحة" : "Notifications available",
    detail: ar ? "لم يتم طلب الإذن بعد. لن يظهر طلب الإذن إلا بعد الضغط على تفعيل الإشعارات." : "Permission not requested. ALYQ asks only after you tap Enable notifications.",
    tone: "neutral" as const,
  };
  if (state === "granted") return {
    title: ar ? "تم منح إذن الإشعارات" : "Notification permission granted",
    detail: ar ? "اضغط تفعيل الإشعارات لإكمال اشتراك هذا المتصفح بأمان." : "Tap Enable notifications to complete this browser's secure subscription.",
    tone: "info" as const,
  };
  if (state === "denied") return {
    title: ar ? "تم رفض إذن الإشعارات" : "Notification permission denied",
    detail: deniedPermissionDetail(lang, options),
    tone: "warning" as const,
  };
  if (state === "registered") return {
    title: ar ? "تم تفعيل الإشعارات" : "Notifications enabled",
    detail: ar ? "سيعرض الجهاز تنبيهًا مختصرًا وآمنًا، بينما تبقى التفاصيل داخل مركز الإشعارات." : "The device will show a minimal safe alert; details remain in Notification Center.",
    tone: "success" as const,
  };
  if (state === "registering") return {
    title: ar ? "جارٍ تفعيل الإشعارات" : "Enabling notifications",
    detail: ar ? "جارٍ تسجيل هذا المتصفح بأمان." : "This browser is being registered securely.",
    tone: "info" as const,
  };
  if (state === "error") return {
    title: ar ? "خطأ في اشتراك الإشعارات" : "Notification subscription error",
    detail: ar ? "تعذر إكمال الاشتراك. لم تتأثر جلسة الدخول ويمكنك المحاولة لاحقًا." : "Subscription could not be completed. Your session is unaffected; try again later.",
    tone: "warning" as const,
  };
  return {
    title: ar ? "الإشعارات غير مدعومة على هذا المتصفح أو الجهاز" : "Notifications are unsupported on this browser or device",
    detail: ar ? "يمكنك متابعة استخدام ALYQ ومركز الإشعارات بشكل طبيعي." : "You can continue using ALYQ and Notification Center normally.",
    tone: "neutral" as const,
  };
}

export function noticeCopy(notice: string | null, lang: "en" | "ar"): string | null {
  if (!notice) return null;
  if (notice === "entity_unavailable") {
    return lang === "ar" ? "لم يعد السجل المرتبط متاحًا في هذا الفرع." : "The linked record is no longer available in this branch.";
  }
  if (notice === "route_unavailable") {
    return lang === "ar" ? "تعذر التحقق من وجهة الإشعار. سنحاول مجددًا عند الاتصال." : "The notification destination could not be verified. It will retry when connected.";
  }
  return lang === "ar" ? "تم رفض وجهة إشعار قديمة أو غير مخوّلة بأمان." : "A stale or unauthorized notification destination was safely refused.";
}

export function MobileNotificationsPage() {
  const { lang } = useI18n();
  const branch = useBranch();
  const mobile = useMobile();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [notifications, setNotifications] = useState<MobileNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [routeNotice, setRouteNotice] = useState<string | null>(noticeCopy(searchParams.get("notice"), lang));

  const load = useCallback(async () => {
    if (!branch.current) return;
    setLoading(true);
    try {
      setNotifications(await listMobileNotifications(100));
      setError(null);
    } catch {
      setError(lang === "ar" ? "تعذر تحديث مركز الإشعارات." : "Notification Center could not be refreshed.");
    } finally {
      setLoading(false);
    }
  }, [branch.current?.id, lang]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void load(); }, [load, mobile.notificationRevision]);
  useEffect(() => { setRouteNotice(noticeCopy(searchParams.get("notice"), lang)); }, [searchParams, lang]);

  const open = async (note: MobileNotification) => {
    const resolved = await resolveMobileNotificationRoute(note.id);
    await markMobileNotificationRead(note.id).catch(() => false);
    setNotifications((rows) => rows.map((row) => row.id === note.id
      ? { ...row, readAt: row.readAt ?? new Date().toISOString() }
      : row));
    await mobile.refreshNotifications();
    if (resolved.ok && resolved.route) {
      navigate(resolved.route);
      return;
    }
    setRouteNotice(noticeCopy(resolved.reason, lang));
  };

  const markAll = async () => {
    try {
      await markAllMobileNotificationsRead();
      const readAt = new Date().toISOString();
      setNotifications((rows) => rows.map((row) => ({ ...row, readAt: row.readAt ?? readAt })));
      await mobile.refreshNotifications();
    } catch {
      setError(lang === "ar" ? "تعذر تحديث حالة القراءة." : "Read state could not be updated.");
    }
  };

  const unread = notifications.filter((note) => !note.readAt).length;
  const pushCopy = pushStateCopy(mobile.pushState, lang, { native: mobile.runtime?.native ?? false });
  return <MobilePage
    title={lang === "ar" ? "الإشعارات" : "Notifications"}
    subtitle={lang === "ar" ? "تنبيهات تشغيلية محفوظة ومخوّلة من الخادم" : "Durable, server-authorized operational attention"}
    actions={unread ? <button type="button" className="mobile-action" onClick={() => void markAll()}>{lang === "ar" ? "تحديد الكل كمقروء" : "Mark all read"}</button> : null}
  >
    <MobileCard className="mobile-push-card">
      <div className="mobile-row">
        <div><strong>{pushCopy.title}</strong><p className="mobile-muted">{pushCopy.detail}</p></div>
        <MobileBadge tone={pushCopy.tone}>{mobile.pushState}</MobileBadge>
      </div>
      <PushDiagnosticsRows diagnostics={mobile.pushDiagnostics} lang={lang} />
      {mobile.pushState === "not_requested" || mobile.pushState === "granted" || mobile.pushState === "error" ? <button type="button" className="mobile-primary-button" onClick={() => void mobile.enablePush()}>{mobile.pushState === "error"
        ? (lang === "ar" ? "إعادة المحاولة" : "Try again")
        : (lang === "ar" ? "تفعيل الإشعارات" : "Enable notifications")}</button> : null}
    </MobileCard>
    <NotificationKindPreferences />

    {routeNotice ? <MobileCard className="mobile-notice-card"><div className="mobile-row"><p>{routeNotice}</p><button type="button" className="mobile-action" onClick={() => setRouteNotice(null)}>{lang === "ar" ? "إخفاء" : "Dismiss"}</button></div></MobileCard> : null}
    {error ? <MobileCard className="mobile-notice-card"><div className="mobile-row"><p>{error}</p><button type="button" className="mobile-action" onClick={() => void load()}>{lang === "ar" ? "إعادة المحاولة" : "Retry"}</button></div></MobileCard> : null}

    {loading && notifications.length === 0
      ? <MobileState kind="loading" title={lang === "ar" ? "جارٍ تحميل الإشعارات" : "Loading notifications"} />
      : notifications.length === 0
        ? <MobileState kind="empty" title={lang === "ar" ? "لا توجد إشعارات" : "Nothing needs attention"} />
        : <div className="mobile-list">{notifications.map((note) => {
            const title = lang === "ar" ? note.titleAr : note.titleEn;
            const body = lang === "ar" ? note.bodyAr : note.bodyEn;
            return <button type="button" className={`mobile-notification ${note.readAt ? "read" : ""}`} key={note.id} onClick={() => void open(note)}>
              <span className="mobile-notification-dot" />
              <span><strong>{title}</strong><small>{body}</small><small>{new Date(note.createdAt).toLocaleString(lang === "ar" ? "ar-EG" : "en-EG")}</small></span>
            </button>;
          })}</div>}
    <p className="mobile-privacy-note">{lang === "ar"
      ? "تحتوي شاشة القفل فقط على تنبيه عام ومرجع مبهم، دون هاتف العميل أو عنوانه أو تفاصيل الدفع أو رموز PIN أو بيانات اعتماد."
      : "Lock-screen payloads contain only a generic notice and opaque reference—never customer phone, address, payment details, PINs, or credentials."}</p>
  </MobilePage>;
}
