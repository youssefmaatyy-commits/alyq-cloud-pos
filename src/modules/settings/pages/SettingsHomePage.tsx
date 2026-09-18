/**
 * Settings home (Phase 46 hub, Phase 49 directory).
 *
 * `/settings` used to bounce straight to the user directory — fine when the
 * directory was the only thing here, wrong now that Settings gathers people,
 * roles, approvals, backups, the brand and the Danger Zone. This page is the
 * honest hub: labelled groups, one card per destination, each labelled with
 * what it actually controls and rendered only when the signed-in role may open
 * it (the routes re-check — this hiding is courtesy, the guard is the law).
 *
 * Phase 49 groups follow the real modules — People & access, Branding, Online
 * store, System — and the sidebar carries only the single Settings door; every
 * section is reached from here. Business information (the shop's name and
 * contact details) lives with the shop window it serves: Online store →
 * Website settings, so no group invents a page that does not exist.
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

interface SettingsGroup {
  key: string;
  labelKey: TranslationKey;
  cards: GroupCard[];
}

export function SettingsHomePage() {
  const { t } = useI18n();
  const { user } = useAuth();

  // Phase 49: the directory groups follow the real destinations — General
  // (the workflow thresholds), Users & roles, Branding, Online store, Backup
  // & restore, Audit log, and System (the Danger Zone, last and loudest).
  // Every card states its own capability; nothing is invented to fill a group.
  const groups: SettingsGroup[] = [
    {
      key: "general",
      labelKey: "admin.settings.group.general",
      cards: [
        {
          to: "/settings/approvals",
          capability: "manage_settings",
          icon: "✓",
          titleKey: "admin.settings.card.approvals.title",
          descKey: "admin.settings.card.approvals.desc",
          testId: "settings-card-approvals",
        },
      ],
    },
    {
      key: "people",
      labelKey: "admin.settings.group.people",
      cards: [
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
      ],
    },
    {
      key: "branding",
      labelKey: "admin.settings.group.branding",
      cards: [
        {
          to: "/settings/branding",
          capability: "manage_website",
          icon: "◆",
          titleKey: "admin.settings.card.branding.title",
          descKey: "admin.settings.card.branding.desc",
          testId: "settings-card-branding",
        },
      ],
    },
    {
      key: "online",
      labelKey: "admin.settings.group.online",
      cards: [
        {
          to: "/online/website",
          capability: "manage_website",
          icon: "🛍",
          titleKey: "admin.settings.card.online.title",
          descKey: "admin.settings.card.online.desc",
          testId: "settings-card-online",
        },
      ],
    },
    {
      key: "backup",
      labelKey: "admin.settings.group.backup",
      cards: [
        {
          to: "/settings/backup",
          capability: "view_backups",
          icon: "⬇",
          titleKey: "admin.settings.card.backup.title",
          descKey: "admin.settings.card.backup.desc",
          testId: "settings-card-backup",
        },
      ],
    },
    {
      key: "audit",
      labelKey: "admin.settings.group.audit",
      cards: [
        {
          to: "/audit",
          capability: "view_audit_log",
          icon: "☰",
          titleKey: "admin.settings.card.audit.title",
          descKey: "admin.settings.card.audit.desc",
          testId: "settings-card-audit",
        },
      ],
    },
    {
      key: "system",
      labelKey: "admin.settings.group.system",
      cards: [
        {
          // Phase 47: the Danger Zone lives last and reads differently on
          // purpose — a card for the acts you must never reach by accident.
          to: "/settings/system",
          capability: "manage_system_reset",
          icon: "⚠",
          titleKey: "admin.settings.card.system.title",
          descKey: "admin.settings.card.system.desc",
          testId: "settings-card-system",
        },
      ],
    },
  ];

  const visibleGroups = groups
    .map((group) => ({
      ...group,
      cards: group.cards.filter((card) => card.capability === null || canActAs(user, card.capability)),
    }))
    .filter((group) => group.cards.length > 0);

  if (visibleGroups.length === 0) {
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
      <PageHeader
        title={t("admin.settings.title")}
        subtitle={t("admin.settings.subtitle")}
        crumbs={[{ label: t("nav.dashboard"), to: "/" }, { label: t("admin.settings.title") }]}
      />
      <div className="space-y-7">
        {visibleGroups.map((group) => (
          <section key={group.key} data-testid={`settings-group-${group.key}`}>
            <h2 className="mb-2 text-[11px] font-black uppercase tracking-widest text-stone-400">
              {t(group.labelKey)}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {group.cards.map((card) => (
                <Link
                  key={card.to + card.testId}
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
          </section>
        ))}
      </div>
    </div>
  );
}
