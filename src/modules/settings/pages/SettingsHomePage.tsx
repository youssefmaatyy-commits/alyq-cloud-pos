/**
 * Settings home (Phase 46).
 *
 * `/settings` used to bounce straight to the user directory — fine when the
 * directory was the only thing here, wrong now that Settings gathers people,
 * roles, approvals, backups and the shared brand. This page is the honest hub:
 * one card per destination, each labelled with what it actually controls and
 * rendered only when the signed-in role may open it (the routes re-check —
 * this hiding is courtesy, the guard is the law).
 */
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { TranslationKey } from "@/lib/i18n/dictionary";
import { useAuth } from "@/lib/auth";
import { canActAs } from "@/lib/permissions/enforce";
import { PageHeader } from "@/components/layout/AppShell";
import { Card, EmptyState } from "@/components/ui";

interface GroupCard {
  to: string;
  capability: Parameters<typeof canActAs>[1] | null;
  icon: string;
  titleKey: TranslationKey;
  descKey: TranslationKey;
  testId: string;
}

export function SettingsHomePage() {
  const { t } = useI18n();
  const { user } = useAuth();

  const cards: GroupCard[] = [
    {
      to: "/settings/branding",
      capability: "manage_website",
      icon: "◆",
      titleKey: "admin.settings.card.branding.title",
      descKey: "admin.settings.card.branding.desc",
      testId: "settings-card-branding",
    },
    {
      to: "/settings/users",
      capability: "manage_users",
      icon: "👥",
      titleKey: "admin.settings.card.users.title",
      descKey: "admin.settings.card.users.desc",
      testId: "settings-card-users",
    },
    {
      to: "/settings/roles",
      capability: "manage_roles",
      icon: "🛡",
      titleKey: "admin.settings.card.roles.title",
      descKey: "admin.settings.card.roles.desc",
      testId: "settings-card-roles",
    },
    {
      to: "/settings/approvals",
      capability: "manage_settings",
      icon: "✓",
      titleKey: "admin.settings.card.approvals.title",
      descKey: "admin.settings.card.approvals.desc",
      testId: "settings-card-approvals",
    },
    {
      to: "/settings/backup",
      capability: "view_backups",
      icon: "⬇",
      titleKey: "admin.settings.card.backup.title",
      descKey: "admin.settings.card.backup.desc",
      testId: "settings-card-backup",
    },
    {
      // Phase 47: the Danger Zone lives last and reads differently on purpose —
      // a card for the acts you must never reach by accident.
      to: "/settings/system",
      capability: "manage_system_reset",
      icon: "⚠",
      titleKey: "admin.settings.card.system.title",
      descKey: "admin.settings.card.system.desc",
      testId: "settings-card-system",
    },
  ];

  const visible = cards.filter((card) => card.capability === null || canActAs(user, card.capability));

  if (visible.length === 0) {
    return (
      <div>
        <PageHeader title={t("admin.settings.title")} subtitle={t("admin.settings.subtitle")} />
        <Card>
          <EmptyState icon="🔒" title={t("admin.settings.noAccess")} description={t("admin.settings.noAccessHint")} />
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title={t("admin.settings.title")} subtitle={t("admin.settings.subtitle")} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {visible.map((card) => (
          <Link
            key={card.to}
            to={card.to}
            data-testid={card.testId}
            className="group rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm transition hover:-translate-y-px hover:border-stone-300 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900"
          >
            <div className="flex items-start gap-3">
              <span
                aria-hidden
                className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-stone-100 text-base text-stone-700 transition group-hover:bg-stone-900 group-hover:text-white"
              >
                {card.icon}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-black text-stone-900">{t(card.titleKey)}</p>
                <p className="mt-0.5 text-xs font-medium leading-relaxed text-stone-500">
                  {t(card.descKey)}
                </p>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
