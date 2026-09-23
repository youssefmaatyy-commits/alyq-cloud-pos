/**
 * Phase 49 — the module landing page.
 *
 * The sidebar shows only the main modules; everything else lives behind one of
 * these. A module home is a short lead and a set of cards, one per sub-screen —
 * nothing more. Cards hide behind the same capability table the route guard
 * reads, so a role that cannot open a screen never sees its card, and no card
 * invents a destination that does not exist.
 */
import { Link } from "react-router-dom";
import { ChevronIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/layout/AppShell";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { canAct } from "@/lib/permissions/enforce";
import { pathAdmits } from "@/lib/permissions/routes";
import type { Capability } from "@/lib/permissions/roles";

export interface ModuleCard {
  /** Stable key — also the card's testid (`module-card-<key>`). */
  key: string;
  to: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  /** Null = any signed-in role, exactly like the route table. */
  capability?: Capability | null;
  badge?: number;
  badgeLabel?: string;
}

export function ModuleHomePage({
  moduleKey,
  title,
  subtitle,
  crumbs,
  cards,
  embedded = false,
}: {
  moduleKey: string;
  title: string;
  subtitle: string;
  crumbs?: { label: string; to?: string }[];
  cards: ModuleCard[];
  embedded?: boolean;
}) {
  const { t } = useI18n();
  const visible = cards.filter((card) => {
    // An explicit card capability is narrower than the path (stock adjustments
    // sit on a screen the path only asks to view). Otherwise the path, including
    // alternates, is the same door the route guard uses.
    if (card.capability) return canAct(card.capability);
    return pathAdmits(card.to, (capability) => canAct(capability));
  });
  if (visible.length === 0) return null;

  return (
    <div data-testid={`module-${moduleKey}`}>
      {embedded ? <div className="mb-4 flex items-baseline gap-4 border-b border-stone-200 pb-3">
        <h2 className="text-sm font-bold uppercase tracking-widest text-stone-800">{title}</h2>
        <p className="hidden text-xs text-stone-500 md:block">{subtitle}</p>
      </div> : <PageHeader
        title={title}
        subtitle={subtitle}
        crumbs={crumbs ?? [{ label: t("nav.dashboard"), to: "/" }, { label: title }]}
      />}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {visible.map((card) => (
          <Link
            key={card.key}
            to={card.to}
            data-testid={`module-card-${card.key}`}
            className="group relative flex flex-col rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm transition hover:-translate-y-px hover:border-stone-300 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900"
          >
            <div className="flex items-start gap-3">
              <span
                aria-hidden
                className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-stone-100 text-base text-stone-700"
              >
                {card.icon}
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-black text-stone-900">{card.title}</span>
                  {card.badge ? (
                    <span
                      aria-label={card.badgeLabel}
                      className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-black tabular-nums text-amber-900"
                    >
                      {card.badge > 99 ? "99+" : card.badge}
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-xs font-medium leading-relaxed text-stone-500">
                  {card.description}
                </span>
              </span>
            </div>
            <span
              aria-hidden
              className="mt-3 inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-widest text-stone-400 transition group-hover:text-stone-700"
            >
              {t("common.open")}
              <ChevronIcon className="h-3 w-3 rtl:rotate-180" />
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
