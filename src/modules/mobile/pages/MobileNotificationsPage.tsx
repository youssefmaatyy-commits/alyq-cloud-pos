import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useBranch } from "@/lib/branch";
import { MobileBadge, MobileCard, MobilePage, MobileState } from "../components/MobilePrimitives";
import { useMobile } from "../MobileContext";
import {
  listMobileNotifications,
  markAllMobileNotificationsRead,
  markMobileNotificationRead,
  resolveMobileNotificationRoute,
  type MobileNotification,
} from "../services/notificationCenter";

function noticeCopy(notice: string | null, lang: "en" | "ar"): string | null {
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
  return <MobilePage
    title={lang === "ar" ? "الإشعارات" : "Notifications"}
    subtitle={lang === "ar" ? "تنبيهات تشغيلية محفوظة ومخوّلة من الخادم" : "Durable, server-authorized operational attention"}
    actions={unread ? <button type="button" className="mobile-action" onClick={() => void markAll()}>{lang === "ar" ? "تحديد الكل كمقروء" : "Mark all read"}</button> : null}
  >
    <MobileCard className="mobile-push-card">
      <div className="mobile-row">
        <div><strong>{lang === "ar" ? "إشعارات الجهاز" : "Native notifications"}</strong><p className="mobile-muted">{mobile.pushState.replace(/_/g, " ")}</p></div>
        <MobileBadge tone={mobile.pushState === "registered" ? "success" : mobile.pushState === "error" || mobile.pushState === "denied" ? "warning" : "neutral"}>{mobile.pushState}</MobileBadge>
      </div>
      {mobile.pushState === "not_requested" ? <button type="button" className="mobile-primary-button" onClick={() => void mobile.enablePush()}>{lang === "ar" ? "تفعيل الإشعارات" : "Enable notifications"}</button> : null}
    </MobileCard>

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
      ? "تحتوي شاشة القفل فقط على نوع آمن ومرجع مبهم، دون هاتف العميل أو عنوانه أو تفاصيل الدفع أو رموز PIN أو بيانات اعتماد."
      : "Lock-screen payloads contain only a safe event type and opaque reference—never customer phone, address, payment details, PINs, or credentials."}</p>
  </MobilePage>;
}
