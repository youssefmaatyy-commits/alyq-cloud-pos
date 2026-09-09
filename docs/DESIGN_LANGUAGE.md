# ALYQ Design Language — Option B (permanent)

Do not redesign. Build new modules **only** from these tokens and primitives.

## Foundations

| Token | Value | Use |
| --- | --- | --- |
| Surface | `white` on `slate-50` page | screens, panels |
| Radius | `rounded-2xl` cards · `rounded-xl` controls | everything |
| Shadow | `--shadow-card` (resting) · `--shadow-raised` (floating) | cards, primary buttons |
| Primary | `indigo-600` → hover `indigo-700` | one primary action per view |
| Font | Inter / Noto Kufi Arabic (html[lang="ar"]) | bilingual UI |
| Spacing | page `px-3 py-4 sm:px-6 sm:py-6`, card `p-4 sm:p-5`, grid gap `gap-3 sm:gap-4` | keep this rhythm |

## Text contrast tiers (mandatory)

| Class | Role |
| --- | --- |
| `.alyq-text-heading` / `text-slate-900` | headings, values, row titles |
| `.alyq-text-body` (`slate-700`) | table cells, list text, descriptions |
| `.alyq-text-muted` (`slate-600`) | subtitles, hints, meta, empty-state copy |
| `.alyq-text-faint` (`slate-500`) | decorative icons only — never body text |

`slate-300`/`slate-400` must not be used for readable text.
Use logical properties (`ps-`, `me-`, `start-`, `end-`) so RTL mirrors automatically.

## Components (reuse, don't re-invent)

- **KPI tile** — `<StatTile label value hint tone icon />` → `.alyq-kpi` with a tone accent edge,
  uppercase `alyq-kpi-label`, large `alyq-kpi-value`, `alyq-kpi-hint`.
  Grid: `grid-cols-2 lg:grid-cols-4` (2 columns on phones, 4 from `lg`).
- **Card** — `.alyq-card` (`rounded-2xl border border-slate-200 bg-white shadow-card`).
- **Primary action** — `<Button>` (renders `.alyq-btn-primary`) or
  `className="alyq-btn-primary alyq-cta …"` for `<Link>` CTAs
  (`.alyq-cta` = full-width on phones, inline from `sm`).
- **Sticky form bar** — `.alyq-actionbar`; stack buttons vertically below `sm`
  (`flex-col-reverse … sm:flex-row`) with full-width buttons.
- **Badges** — `<Badge tone>` and `ActiveBadge` / `ProductTypeBadge`; tones carry `ring-1`
  and `-800` text for AA contrast.
- **Filters** — `.alyq-card` container, chips `rounded-full` with `ring-1`, count pill
  `bg-indigo-50 text-indigo-800 ring-indigo-200`.
- **Feedback** — `LoadingBlock`, `EmptyState`, `ErrorState`, `ConfirmDialog`, `useToast`.

## Responsive rules

1. Mobile-first single column; tables become card lists below `md`.
2. Page header stacks: title block, then actions (CTA full-width on phones).
3. Filter grids: `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`; search spans two columns from `sm`.
4. Icon-only actions need `title` + `aria-label`; minimum 32×32 px tap target.
5. Direction is set on `<html>` by `I18nProvider`; never hardcode `left`/`right`.

## Checklist for every new module

- [ ] Only the text tiers above; no `slate-300/400` copy
- [ ] One `.alyq-btn-primary` / `.alyq-cta` per view
- [ ] KPIs use `StatTile`, panels use `.alyq-card`
- [ ] Works at 360 px width and in RTL
- [ ] All copy through `t()` — both `en` and `ar` keys
