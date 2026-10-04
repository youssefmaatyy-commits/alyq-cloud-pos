/**
 * The data-health panel.
 *
 * A report is only useful if it says what was looked at as well as what was
 * wrong: "no findings" over twelve products is a different sentence from "no
 * findings" over twelve thousand, so the examined counts are printed next to the
 * verdict rather than hidden behind it.
 *
 * Each finding carries the message, the recommendation and a few identifiers.
 * The recommendation points at the tool that already fixes the problem — an
 * adjustment on the inventory screen, a release on the online-orders screen, a
 * role on the users screen — because a report that names a problem and stops
 * there is a report somebody else has to finish.
 */
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Badge, Button, Card, SectionTitle } from "@/components/ui";
import type { HealthIssue, HealthReport } from "../types";

const SEVERITY_TONE = {
  critical: "danger",
  warning: "warning",
  info: "info",
} as const;

const AREA_ORDER = ["inventory", "sales", "financial", "online", "identity", "audit"] as const;

export function HealthPanel({
  report,
  busy,
  mayRun,
  needsExport,
  onRun,
}: {
  report: HealthReport | null;
  busy: boolean;
  mayRun: boolean;
  /** Live mode reads every table to check them, which is also what a download does. */
  needsExport: boolean;
  onRun: () => void;
}) {
  const { t, num, date } = useI18n();

  const grouped = (report?.issues ?? []).reduce<Record<string, HealthIssue[]>>((acc, issue) => {
    const list = acc[issue.area] ?? [];
    list.push(issue);
    acc[issue.area] = list;
    return acc;
  }, {});
  const areas = AREA_ORDER.filter((area) => (grouped[area] ?? []).length > 0);

  return (
    <Card>
      <SectionTitle
        aside={
          mayRun && !needsExport ? (
            <Button
              variant={report ? "secondary" : "primary"}
              size="sm"
              loading={busy}
              onClick={onRun}
            >
              {t("backup.health.run")}
            </Button>
          ) : null
        }
      >
        {t("backup.health.title")}
      </SectionTitle>

      <p className="mt-1 text-xs leading-relaxed text-slate-600">{t("backup.health.hint")}</p>

      {needsExport ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
          {t("backup.health.needsExport")}
        </p>
      ) : null}

      {!report ? (
        <p className="mt-4 text-xs text-slate-500">{t("backup.notRun")}</p>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {report.ok ? (
              <Badge tone="success">{t("backup.health.clean")}</Badge>
            ) : (
              <Badge tone={report.worst === "critical" ? "danger" : "warning"}>
                {t("backup.health.issues", { count: num(report.issues.length) })}
              </Badge>
            )}
            <span className="text-[11px] text-slate-500">
              {t("backup.health.ranAt", {
                time: date(report.ran_at),
                ms: num(report.duration_ms, 0),
              })}
            </span>
          </div>

          {/* What was examined. A clean report next to its scope is a result;
              without it, it is an absence of news. */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
              {t("backup.health.examined")}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-600">
              {Object.entries(report.examined)
                .filter(([, count]) => count > 0)
                .map(([key, count]) => `${num(count)} ${t(`backup.health.examined.${key}` as never)}`)
                .join(" · ")}
            </p>
          </div>

          {areas.length === 0 ? null : (
            <div className="space-y-3">
              {areas.map((area) => (
                <div key={area} className="space-y-2">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                    {t(`backup.health.area.${area}` as never)}
                  </p>
                  <ul className="space-y-2">
                    {(grouped[area] ?? []).map((issue) => (
                      <li
                        key={`${area}-${issue.code}`}
                        className="rounded-xl border border-slate-200 bg-white p-3"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={SEVERITY_TONE[issue.severity]}>
                            {t(`backup.health.severity.${issue.severity}` as never)}
                          </Badge>
                          <p className="text-sm font-semibold text-slate-900">
                            {t(`backup.health.${issue.code}.message` as never)}
                          </p>
                          <span className="ms-auto text-[11px] text-slate-500">
                            {t("backup.health.finding", { count: num(issue.count) })}
                          </span>
                        </div>
                        <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
                          {t(`backup.health.${issue.code}.recommendation` as never)}
                        </p>
                        {issue.samples.length > 0 ? (
                          <p className="mt-1.5 font-mono text-[10px] text-slate-500">
                            {issue.samples.join(" · ")}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
