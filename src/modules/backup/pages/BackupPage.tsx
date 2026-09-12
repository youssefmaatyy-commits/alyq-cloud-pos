/**
 * Settings → Backup & recovery (Phase 18).
 *
 * One screen, four jobs, and the order is the order an operator asks them in:
 *
 *   1. **Are we protected?** Six tiles answering the monitoring question before
 *      anything else — the newest snapshot, the last restore, what the schedule
 *      will do next, how much room the snapshots take, and what the last health
 *      check found.
 *   2. **Take one.** A snapshot by hand, with a note, because the useful ones are
 *      the ones somebody can identify a month later ("before the July price
 *      change").
 *   3. **Keep it honest.** The schedule and its retention, which is a promise
 *      about how much work the shop is prepared to lose.
 *   4. **Get it back.** Restore, from a stored snapshot or from a file, behind a
 *      typed confirmation; and the emergency workbook, for the day the thing that
 *      breaks is the app itself.
 *
 * Everything here goes through `services/backupService`, which asserts the
 * capability and writes the audit entry. The screen only decides what to show and
 * what to enable, so a seat without a capability sees an explanation rather than
 * a button that fails — and in live mode the database refuses the same acts again,
 * because a restore is not something a browser should be the only gate on.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  LoadingBlock,
  SectionTitle,
  SelectInput,
  StatTile,
  TextInput,
  useToast,
} from "@/components/ui";
import { ArchiveIcon, DownloadIcon, RestoreIcon } from "@/components/ui/icons";
import { canAct } from "@/lib/permissions/enforce";
import {
  afterRestore,
  automaticBackupIfDue,
  createBackup,
  describeBackupError,
  downloadBackup,
  getMode,
  loadBackups,
  loadStatus,
  restoreBackup,
  runHealthCheck,
  saveBackupSettings,
} from "../services/backupService";
import { exportEmergencyWorkbook } from "../services/emergencyExport";
import { parseBackupDocument } from "../schema";
import { formatBytes } from "../services/schedule";
import { RestoreDialog, type RestoreTarget } from "../components/RestoreDialog";
import { HealthPanel } from "../components/HealthPanel";
import type {
  BackupManifest,
  BackupSettings,
  BackupStatusSummary,
  HealthReport,
} from "../types";

const STATUS_TONE = {
  protected: "success",
  due: "warning",
  overdue: "danger",
  never: "danger",
  disabled: "neutral",
} as const;

export function BackupPage() {
  const { t, date, num, pick, lang } = useI18n();
  const toast = useToast();
  const mode = getMode();

  const mayCreate = canAct("create_backup");
  const mayRestore = canAct("restore_backup");
  const mayExport = canAct("export_backup");
  const mayHealth = canAct("run_health_check");
  const maySchedule = canAct("manage_settings");
  const mayEmergency = canAct("export_data");
  // A live health check reads every table through the same function a download
  // uses, so it needs the same authority. The service enforces this; the screen
  // explains it instead of letting the button fail.
  const healthNeedsExport = mode === "supabase" && !mayExport;

  const [summary, setSummary] = useState<BackupStatusSummary | null>(null);
  const [backups, setBackups] = useState<BackupManifest[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);

  const [note, setNote] = useState("");
  const [creating, setCreating] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<RestoreTarget | null>(null);
  const [pickedFile, setPickedFile] = useState<{ name: string; text: string } | null>(null);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [healthBusy, setHealthBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    const [nextSummary, nextBackups] = await Promise.all([loadStatus(), loadBackups()]);
    setSummary(nextSummary);
    setBackups(nextBackups);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [nextSummary, nextBackups] = await Promise.all([loadStatus(), loadBackups()]);
        if (cancelled) return;
        setSummary(nextSummary);
        setBackups(nextBackups);
        setFailure(null);
      } catch (error) {
        if (!cancelled) setFailure(describeBackupError(error).key);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * The schedule's safety net.
   *
   * A database job takes automatic snapshots in live mode when the project has
   * `pg_cron`; where it does not — and always, offline — the snapshot is taken by
   * the first admin to open this panel after one falls due. Best effort by
   * contract: the service swallows every failure, so a full disk or a refused
   * write can never stop an admin from opening the panel they came to.
   */
  const automaticTried = useRef(false);
  useEffect(() => {
    if (!mayCreate || automaticTried.current) return;
    automaticTried.current = true;
    void automaticBackupIfDue().then((manifest) => {
      if (!manifest) return;
      toast.push(
        t("backup.create.done", {
          rows: num(manifest.row_count),
          tables: num(manifest.table_count),
        }),
        "info",
      );
      void refresh();
    });
  }, [mayCreate, num, refresh, t, toast]);

  const settings: BackupSettings | null = summary?.settings ?? null;

  async function onCreate() {
    setCreating(true);
    try {
      const manifest = await createBackup("manual", note.trim() || null);
      toast.success(
        t("backup.create.done", {
          rows: num(manifest.row_count),
          tables: num(manifest.table_count),
        }),
      );
      setNote("");
      await refresh();
    } catch (error) {
      toast.error(t(describeBackupError(error).key as never));
    } finally {
      setCreating(false);
    }
  }

  async function onDownload(id: string) {
    setDownloadingId(id);
    try {
      await downloadBackup(id);
      toast.success(t("backup.download.done"));
    } catch (error) {
      toast.error(t(describeBackupError(error).key as never));
    } finally {
      setDownloadingId(null);
    }
  }

  function openStoredRestore(manifest: BackupManifest) {
    setRestoreTarget({
      id: manifest.id,
      label: `${t(`backup.kind.${manifest.kind}` as never)} · ${date(manifest.created_at)}`,
      rows: manifest.row_count,
      tables: manifest.table_count,
      sizeBytes: manifest.size_bytes,
      takenAt: manifest.created_at,
      takenBy: manifest.created_by_name,
    });
  }

  /**
   * Read a picked file, and refuse it here if it is not a backup.
   *
   * The service validates again — this check is for the operator's benefit, so a
   * spreadsheet picked by mistake is named at the moment of picking rather than
   * after a confirmation word has been typed.
   */
  async function onPickFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseBackupDocument(text);
      if (!parsed.ok) {
        toast.error(t(`backup.error.${parsed.code}` as never));
        return;
      }
      setPickedFile({ name: file.name, text });
      setRestoreTarget({
        fileText: text,
        label: `${file.name} · ${formatBytes(file.size)}`,
        rows: parsed.document.row_count,
        tables: Object.keys(parsed.document.counts ?? {}).length,
        sizeBytes: parsed.document.size_bytes,
        takenAt: parsed.document.created_at,
        takenBy: parsed.document.created_by?.name || null,
      });
    } catch {
      toast.error(t("backup.error.unparseable"));
    }
  }

  async function onConfirmRestore(confirmation: string) {
    const target = restoreTarget;
    if (!target) return;
    setRestoring(true);
    try {
      const outcome = await restoreBackup({
        id: target.id,
        fileText: target.fileText,
        confirmation,
      });
      toast.success(t("backup.restore.done", { rows: num(outcome.row_count) }));
      setRestoreTarget(null);
      setPickedFile(null);
      // Every provider in the app holds a cache of the data that has just been
      // replaced. Reloading is the only way to rebuild all of them at once, and a
      // stale cache after a restore is a till selling stock that no longer exists.
      afterRestore();
    } catch (error) {
      toast.error(t(describeBackupError(error).key as never));
      await refresh().catch(() => undefined);
    } finally {
      setRestoring(false);
    }
  }

  async function onSaveSchedule() {
    if (!settings) return;
    setScheduleBusy(true);
    try {
      await saveBackupSettings(settings);
      toast.success(t("backup.schedule.saved"));
      await refresh();
    } catch (error) {
      toast.error(t(describeBackupError(error).key as never));
    } finally {
      setScheduleBusy(false);
    }
  }

  function patchSettings(patch: Partial<BackupSettings>) {
    setSummary((prev) =>
      prev ? { ...prev, settings: { ...prev.settings, ...patch } } : prev,
    );
  }

  async function onRunHealth() {
    setHealthBusy(true);
    try {
      const report = await runHealthCheck();
      setHealth(report);
      if (report.ok) toast.success(t("backup.health.clean"));
      else toast.push(t("backup.health.issues", { count: num(report.issues.length) }), "info");
    } catch (error) {
      toast.error(t(describeBackupError(error).key as never));
    } finally {
      setHealthBusy(false);
    }
  }

  async function onEmergencyExport() {
    setExporting(true);
    try {
      const outcome = await exportEmergencyWorkbook({ t, pick, lang });
      if (outcome.skipped.length > 0) {
        toast.push(
          t("backup.emergency.partial", {
            count: num(outcome.skipped.length),
            sections: outcome.skipped
              .map((key) => t(`backup.emergency.section.${key}` as never))
              .join("، "),
          }),
          "info",
        );
      } else {
        toast.success(t("backup.emergency.done"));
      }
    } catch (error) {
      toast.error(t(describeBackupError(error).key as never));
    } finally {
      setExporting(false);
    }
  }

  if (loading && !summary) {
    return <LoadingBlock label={t("backup.list.loading")} className="min-h-[60vh]" />;
  }

  if (failure && !summary) {
    return (
      <div className="p-4 sm:p-6">
        <ErrorState
          title={t("backup.title")}
          message={t(failure as never)}
          retryLabel={t("common.retry")}
          onRetry={() => window.location.reload()}
        />
      </div>
    );
  }

  const status = summary?.status ?? "never";

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title={t("backup.title")}
        subtitle={t("backup.subtitle")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={mode === "supabase" ? "info" : "neutral"}>
              {mode === "supabase" ? t("backup.mode.live") : t("backup.mode.demo")}
            </Badge>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void refresh()}
              disabled={loading}
            >
              {t("backup.refresh")}
            </Button>
          </div>
        }
      />

      <p className="text-xs text-slate-600">
        {mode === "supabase" ? t("backup.mode.liveHint") : t("backup.mode.demoHint")}
      </p>

      {/* ── monitoring: the six questions an admin asks first ─────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <StatTile
          label={t("backup.status.title")}
          value={t(`backup.status.${status}` as never)}
          hint={t(`backup.status.${status}Hint` as never)}
          tone={STATUS_TONE[status]}
          icon={<ArchiveIcon />}
        />
        <StatTile
          label={t("backup.tile.lastBackup")}
          value={summary?.last_backup ? date(summary.last_backup.created_at) : t("backup.never")}
          hint={
            summary?.last_backup
              ? `${t(`backup.kind.${summary.last_backup.kind}` as never)} · ${
                  summary.last_backup.created_by_name || t("backup.unknownUser")
                }`
              : t("backup.status.neverHint")
          }
          icon={<ArchiveIcon />}
        />
        <StatTile
          label={t("backup.tile.lastRestore")}
          value={summary?.last_restore ? date(summary.last_restore.at) : t("backup.never")}
          hint={summary?.last_restore?.by || undefined}
          icon={<RestoreIcon />}
        />
        <StatTile
          label={t("backup.tile.nextAutomatic")}
          value={
            summary?.next_automatic_due_at
              ? date(summary.next_automatic_due_at)
              : t("backup.schedule.frequency.off")
          }
          hint={
            settings
              ? `${t(`backup.schedule.frequency.${settings.frequency}` as never)} · ${t(
                  "backup.schedule.lastAutomatic",
                )}: ${
                  summary?.last_automatic_at ? date(summary.last_automatic_at) : t("backup.never")
                }`
              : undefined
          }
          icon={<RestoreIcon />}
        />
        <StatTile
          label={t("backup.tile.storage")}
          value={formatBytes(summary?.total_size_bytes ?? 0)}
          hint={`${num(summary?.backup_count ?? 0)} ${t("backup.tile.snapshots")}`}
        />
        <StatTile
          label={t("backup.tile.health")}
          value={
            health
              ? health.ok
                ? t("backup.health.severity.info")
                : t(`backup.health.severity.${health.worst ?? "info"}` as never)
              : t("backup.notRun")
          }
          hint={
            health
              ? health.ok
                ? t("backup.health.clean")
                : t("backup.health.issues", { count: num(health.issues.length) })
              : undefined
          }
          tone={health && !health.ok ? (health.worst === "critical" ? "danger" : "warning") : "neutral"}
        />
      </div>

      {/* ── snapshots ─────────────────────────────────────────────────────── */}
      <Card>
        <SectionTitle
          aside={
            mayCreate ? (
              <div className="flex flex-wrap items-end gap-2">
                <div className="w-48">
                  <TextInput
                    value={note}
                    maxLength={200}
                    placeholder={t("backup.create.notePlaceholder")}
                    aria-label={t("backup.create.note")}
                    onChange={(event) => setNote(event.target.value)}
                    disabled={creating}
                  />
                </div>
                <Button size="sm" loading={creating} onClick={() => void onCreate()}>
                  {creating ? t("backup.create.working") : t("backup.create.submit")}
                </Button>
              </div>
            ) : null
          }
        >
          {t("backup.section.snapshots")}
        </SectionTitle>
        <p className="mt-1 text-xs leading-relaxed text-slate-600">
          {t("backup.section.snapshotsHint")}
        </p>
        {mayCreate ? (
          <p className="mt-1 text-[11px] text-slate-500">{t("backup.create.hint")}</p>
        ) : (
          <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
            {t("permissions.denied.create_backup")}
          </p>
        )}

        <div className="mt-4 overflow-x-auto">
          {backups.length === 0 ? (
            <EmptyState
              icon="🗄️"
              title={t("backup.list.empty")}
              description={t("backup.section.snapshotsHint")}
            />
          ) : (
            <table className="w-full min-w-[820px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-[10px] uppercase tracking-widest text-slate-500">
                  <th className="px-2 py-2 text-start font-bold">{t("backup.list.date")}</th>
                  <th className="px-2 py-2 text-start font-bold">{t("backup.list.kind")}</th>
                  <th className="px-2 py-2 text-start font-bold">{t("backup.list.note")}</th>
                  <th className="px-2 py-2 text-end font-bold">{t("backup.list.rows")}</th>
                  <th className="px-2 py-2 text-end font-bold">{t("backup.list.tables")}</th>
                  <th className="px-2 py-2 text-end font-bold">{t("backup.list.size")}</th>
                  <th className="px-2 py-2 text-start font-bold">{t("backup.list.by")}</th>
                  <th className="px-2 py-2 text-start font-bold">{t("backup.list.checksum")}</th>
                  <th className="px-2 py-2 text-end font-bold">{t("backup.list.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {backups.map((manifest) => (
                  <tr key={manifest.id} className="border-b border-slate-100 last:border-0">
                    <td className="whitespace-nowrap px-2 py-2 text-xs text-slate-700">
                      {date(manifest.created_at)}
                    </td>
                    <td className="px-2 py-2">
                      <Badge
                        tone={
                          manifest.kind === "pre_restore"
                            ? "warning"
                            : manifest.kind === "automatic"
                              ? "info"
                              : "neutral"
                        }
                      >
                        {t(`backup.kind.${manifest.kind}` as never)}
                      </Badge>
                    </td>
                    <td className="max-w-[220px] truncate px-2 py-2 text-xs text-slate-600">
                      {manifest.note || "—"}
                    </td>
                    <td className="px-2 py-2 text-end text-xs tabular-nums text-slate-700">
                      {num(manifest.row_count, 0)}
                    </td>
                    <td className="px-2 py-2 text-end text-xs tabular-nums text-slate-700">
                      {num(manifest.table_count, 0)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-end text-xs tabular-nums text-slate-700">
                      {formatBytes(manifest.size_bytes)}
                    </td>
                    <td className="max-w-[140px] truncate px-2 py-2 text-xs text-slate-600">
                      {manifest.created_by_name || t("backup.unknownUser")}
                    </td>
                    <td className="px-2 py-2 font-mono text-[10px] text-slate-500">
                      {manifest.checksum ? manifest.checksum.slice(0, 8) : "—"}
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={!mayExport}
                          loading={downloadingId === manifest.id}
                          onClick={() => void onDownload(manifest.id)}
                          title={mayExport ? undefined : t("permissions.denied.export_backup")}
                        >
                          <DownloadIcon />
                          <span className="ms-1">{t("backup.download")}</span>
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          disabled={!mayRestore}
                          onClick={() => openStoredRestore(manifest)}
                          title={mayRestore ? undefined : t("permissions.denied.restore_backup")}
                        >
                          <RestoreIcon />
                          <span className="ms-1">{t("backup.restore")}</span>
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Restoring from a file is the path for a backup taken on another device,
            or for the day this installation will not open at all. */}
        {mayRestore ? (
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-bold text-slate-800">{t("backup.restore.fileTitle")}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-600">
              {t("backup.restore.fileHint")}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                ref={fileInput}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(event) => void onPickFile(event)}
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => fileInput.current?.click()}
                disabled={restoring}
              >
                {t("backup.restore.filePick")}
              </Button>
              {pickedFile ? (
                <span className="text-[11px] text-slate-600">
                  {t("backup.restore.filePicked", {
                    name: pickedFile.name,
                    size: formatBytes(pickedFile.text.length),
                  })}
                </span>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
            {t("permissions.denied.restore_backup")} {t("backup.restore.rollbackHint")}
          </p>
        )}
      </Card>

      {/* ── schedule ──────────────────────────────────────────────────────── */}
      <Card>
        <SectionTitle>{t("backup.schedule.title")}</SectionTitle>
        <p className="mt-1 text-xs leading-relaxed text-slate-600">{t("backup.schedule.hint")}</p>

        {settings ? (
          maySchedule ? (
            <>
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <Field label={t("backup.schedule.frequency")}>
                  <SelectInput
                    value={settings.frequency}
                    onChange={(event) =>
                      patchSettings({
                        frequency: event.target.value as BackupSettings["frequency"],
                      })
                    }
                  >
                    <option value="off">{t("backup.schedule.frequency.off")}</option>
                    <option value="daily">{t("backup.schedule.frequency.daily")}</option>
                    <option value="weekly">{t("backup.schedule.frequency.weekly")}</option>
                  </SelectInput>
                </Field>
                <Field label={t("backup.schedule.retentionDays")}>
                  <TextInput
                    type="number"
                    min={1}
                    max={3650}
                    value={String(settings.retention_days)}
                    onChange={(event) =>
                      patchSettings({ retention_days: Number(event.target.value) || 1 })
                    }
                  />
                </Field>
                <Field label={t("backup.schedule.retentionCount")}>
                  <TextInput
                    type="number"
                    min={1}
                    max={500}
                    value={String(settings.retention_count)}
                    onChange={(event) =>
                      patchSettings({ retention_count: Number(event.target.value) || 1 })
                    }
                  />
                </Field>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button size="sm" loading={scheduleBusy} onClick={() => void onSaveSchedule()}>
                  {scheduleBusy ? t("backup.schedule.saving") : t("backup.schedule.save")}
                </Button>
                {settings.updated_by_name ? (
                  <span className="text-[11px] text-slate-500">
                    {t("backup.schedule.updatedBy", { name: settings.updated_by_name })}
                  </span>
                ) : null}
              </div>
              {/* The consequence of the policy, next to the policy: an admin
                  changing the window should see what it now means without
                  reading the tile at the top of the page. */}
              <p className="mt-2 text-[11px] text-slate-600">
                {t("backup.schedule.nextDue")}:{" "}
                {summary?.next_automatic_due_at
                  ? date(summary.next_automatic_due_at)
                  : t("backup.schedule.frequency.off")}{" "}
                · {t("backup.schedule.lastAutomatic")}:{" "}
                {summary?.last_automatic_at
                  ? date(summary.last_automatic_at)
                  : t("backup.never")}
              </p>
            </>
          ) : (
            <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
              {t(`backup.schedule.frequency.${settings.frequency}` as never)} ·{" "}
              {t("backup.schedule.retentionDays")}: {num(settings.retention_days, 0)} ·{" "}
              {t("backup.schedule.retentionCount")}: {num(settings.retention_count, 0)}
            </p>
          )
        ) : null}

        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          {mode === "supabase" ? t("backup.schedule.cronNote") : t("backup.schedule.appNote")}{" "}
          {t("backup.schedule.retentionNote")}
        </p>
      </Card>

      {/* ── data health ───────────────────────────────────────────────────── */}
      <HealthPanel
        report={health}
        busy={healthBusy}
        mayRun={mayHealth}
        needsExport={healthNeedsExport}
        onRun={() => void onRunHealth()}
      />

      {/* ── emergency export ──────────────────────────────────────────────── */}
      <Card>
        <SectionTitle
          aside={
            <Button
              size="sm"
              variant="secondary"
              loading={exporting}
              disabled={!mayEmergency}
              onClick={() => void onEmergencyExport()}
              title={mayEmergency ? undefined : t("permissions.denied.export_data")}
            >
              {exporting ? t("backup.emergency.running") : t("backup.emergency.run")}
            </Button>
          }
        >
          {t("backup.emergency.title")}
        </SectionTitle>
        <p className="mt-1 text-xs leading-relaxed text-slate-600">{t("backup.emergency.hint")}</p>
        <p className="mt-2 text-[11px] text-slate-500">{t("backup.emergency.financialNote")}</p>
        {!mayEmergency ? (
          <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
            {t("permissions.denied.export_data")}
          </p>
        ) : null}
      </Card>

      <RestoreDialog
        target={restoreTarget}
        busy={restoring}
        onClose={() => {
          setRestoreTarget(null);
          setPickedFile(null);
        }}
        onConfirm={(confirmation) => void onConfirmRestore(confirmation)}
      />
    </div>
  );
}
