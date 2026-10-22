import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useBranch } from "@/lib/branch";
import { PageHeader } from "@/components/layout/AppShell";
import { MobileBadge, MobileCard, MobileState } from "@/modules/mobile/components/MobilePrimitives";
import { noticeCopy, pushStateCopy } from "@/modules/mobile/pages/MobileNotificationsPage";
import {
  listMobileNotifications,
  markAllMobileNotificationsRead,
  markMobileNotificationRead,
  resolveWebNotificationRoute,
  type MobileNotification,
} from "@/modules/mobile/services/notificationCenter";
import { useWebNotifications } from "./WebNotificationsContext";
import "@/modules/mobile/mobile.css";

export function WebNotificationsPage() {
  const { lang, t } = useI18n();
  const branch = useBranch();
  const webNotifications = useWebNotifications();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [notifications, setNotifications] = useState<MobileNotification[]>([]);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [routeNotice, setRouteNotice] = useState<string | null>(
    noticeCopy(searchParams.get("notice"), lang),
  );

  const load = useCallback(async () => {
    if (!branch.current) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setNotifications(await listMobileNotifications(100));
      setError(null);
    } catch {
      setError(
        lang === "ar"
          ? "تعذر تحديث مركز الإشعارات."
          : "Notification Center could not be refreshed.",
      );
    } finally {
      setLoading(false);
    }
  }, [branch.current?.id, lang]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load();
  }, [load, webNotifications.notificationRevision]);

  useEffect(() => {
    setRouteNotice(noticeCopy(searchParams.get("notice"), lang));
  }, [searchParams, lang]);

  const open = async (note: MobileNotification) => {
    const resolved = await resolveWebNotificationRoute(note.id);
    await markMobileNotificationRead(note.id).catch(() => false);
    setNotifications((rows) =>
      rows.map((row) =>
        row.id === note.id
          ? { ...row, readAt: row.readAt ?? new Date().toISOString() }
          : row,
      ),
    );
    await webNotifications.refreshNotifications();
    if (resolved.ok && resolved.route) {
      navigate(resolved.route);
      return;
    }
    setRouteNotice(noticeCopy(resolved.reason, lang));
  };

  const markOneRead = async (note: MobileNotification) => {
    if (note.readAt) return;
    try {
      await markMobileNotificationRead(note.id);
      const readAt = new Date().toISOString();
      setNotifications((rows) =>
        rows.map((row) => (row.id === note.id ? { ...row, readAt } : row)),
      );
      await webNotifications.refreshNotifications();
    } catch {
      setError(
        lang === "ar"
          ? "تعذر تحديث حالة القراءة."
          : "Read state could not be updated.",
      );
    }
  };

  const markAll = async () => {
    try {
      await markAllMobileNotificationsRead();
      const readAt = new Date().toISOString();
      setNotifications((rows) =>
        rows.map((row) => ({ ...row, readAt: row.readAt ?? readAt })),
      );
      await webNotifications.refreshNotifications();
    } catch {
      setError(
        lang === "ar"
          ? "تعذر تحديث حالة القراءة."
          : "Read state could not be updated.",
      );
    }
  };

  const unread = notifications.filter((note) => !note.readAt).length;
  const visible =
    filter === "unread"
      ? notifications.filter((note) => !note.readAt)
      : notifications;
  const pushCopy = pushStateCopy(webNotifications.pushState, lang);

  return (
    <div data-testid="web-notifications-page" className="space-y-4">
      <PageHeader
        crumbs={[
          { label: t("nav.dashboard"), to: "/dashboard" },
          { label: lang === "ar" ? "الإشعارات" : "Notifications" },
        ]}
        title={lang === "ar" ? "الإشعارات" : "Notifications"}
        subtitle={
          lang === "ar"
            ? "تنبيهات تشغيلية محفوظة ومخوّلة من الخادم"
            : "Durable, server-authorized operational attention"
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1">
              <button
                type="button"
                onClick={() => setFilter("all")}
                className={`rounded-lg px-3 py-1 text-xs font-bold transition ${
                  filter === "all"
                    ? "bg-[#172033] text-white"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {lang === "ar"
                  ? `الكل (${notifications.length})`
                  : `All (${notifications.length})`}
              </button>
              <button
                type="button"
                onClick={() => setFilter("unread")}
                className={`rounded-lg px-3 py-1 text-xs font-bold transition ${
                  filter === "unread"
                    ? "bg-[#172033] text-white"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {lang === "ar" ? `غير مقروء (${unread})` : `Unread (${unread})`}
              </button>
            </div>
            <button
              type="button"
              className="mobile-action"
              onClick={() => void load()}
            >
              {lang === "ar" ? "تحديث" : "Refresh"}
            </button>
            {unread > 0 ? (
              <button
                type="button"
                className="mobile-action"
                onClick={() => void markAll()}
              >
                {lang === "ar" ? "تحديد الكل كمقروء" : "Mark all read"}
              </button>
            ) : null}
          </div>
        }
      />

      <MobileCard className="mobile-push-card">
        <div className="mobile-row">
          <div>
            <strong>{pushCopy.title}</strong>
            <p className="mobile-muted">{pushCopy.detail}</p>
          </div>
          <MobileBadge tone={pushCopy.tone}>
            {webNotifications.pushState}
          </MobileBadge>
        </div>
        {webNotifications.pushState === "not_requested" ||
        webNotifications.pushState === "granted" ||
        webNotifications.pushState === "error" ? (
          <button
            type="button"
            className="mobile-primary-button sm:w-auto sm:px-5"
            onClick={() => void webNotifications.enablePush()}
          >
            {webNotifications.pushState === "error"
              ? lang === "ar"
                ? "إعادة المحاولة"
                : "Try again"
              : lang === "ar"
                ? "تفعيل الإشعارات"
                : "Enable notifications"}
          </button>
        ) : null}
      </MobileCard>

      {routeNotice ? (
        <MobileCard className="mobile-notice-card">
          <div className="mobile-row">
            <p>{routeNotice}</p>
            <button
              type="button"
              className="mobile-action"
              onClick={() => setRouteNotice(null)}
            >
              {lang === "ar" ? "إخفاء" : "Dismiss"}
            </button>
          </div>
        </MobileCard>
      ) : null}

      {error ? (
        <MobileCard className="mobile-notice-card">
          <div className="mobile-row">
            <p>{error}</p>
            <button
              type="button"
              className="mobile-action"
              onClick={() => void load()}
            >
              {lang === "ar" ? "إعادة المحاولة" : "Retry"}
            </button>
          </div>
        </MobileCard>
      ) : null}

      {loading && notifications.length === 0 ? (
        <MobileState
          kind="loading"
          title={
            lang === "ar" ? "جارٍ تحميل الإشعارات" : "Loading notifications"
          }
        />
      ) : visible.length === 0 ? (
        <MobileState
          kind="empty"
          title={
            lang === "ar" ? "لا توجد إشعارات" : "Nothing needs attention"
          }
        />
      ) : (
        <div className="mobile-list grid gap-3 lg:grid-cols-2">
          {visible.map((note) => {
            const title = lang === "ar" ? note.titleAr : note.titleEn;
            const body = lang === "ar" ? note.bodyAr : note.bodyEn;
            return (
              <div
                key={note.id}
                className={`mobile-notification ${note.readAt ? "read" : ""}`}
              >
                <span className="mobile-notification-dot" />
                <div className="flex flex-col justify-between gap-2">
                  <button
                    type="button"
                    className="text-start"
                    onClick={() => void open(note)}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <strong>{title}</strong>
                      <MobileBadge tone={note.readAt ? "neutral" : "info"}>
                        {note.kind || (note.readAt
                          ? lang === "ar"
                            ? "مقروء"
                            : "Read"
                          : lang === "ar"
                            ? "جديد"
                            : "New")}
                      </MobileBadge>
                    </div>
                    <small>{body}</small>
                    <small>
                      {new Date(note.createdAt).toLocaleString(
                        lang === "ar" ? "ar-EG" : "en-EG",
                      )}
                    </small>
                  </button>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <button
                      type="button"
                      className="mobile-action text-xs"
                      onClick={() => void open(note)}
                    >
                      {lang === "ar" ? "فتح السجل" : "Open"}
                    </button>
                    {!note.readAt ? (
                      <button
                        type="button"
                        className="mobile-action text-xs"
                        onClick={() => void markOneRead(note)}
                      >
                        {lang === "ar" ? "تحديد كمقروء" : "Mark read"}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="mobile-privacy-note">
        {lang === "ar"
          ? "تحتوي شاشة القفل فقط على تنبيه عام ومرجع مبهم، دون هاتف العميل أو عنوانه أو تفاصيل الدفع أو رموز PIN أو بيانات اعتماد."
          : "Lock-screen payloads contain only a generic notice and opaque reference—never customer phone, address, payment details, PINs, or credentials."}
      </p>
    </div>
  );
}
