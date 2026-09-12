/**
 * The restore dialog — the last thing between an admin and replacing the
 * installation's data.
 *
 * Three deliberate frictions, none of which is decoration:
 *
 *   1. It says what is lost, in numbers. "This replaces your data" is a sentence
 *      everybody clicks past; "everything written after 12 September is lost,
 *      including sales already taken" is a sentence that stops somebody who came
 *      here by accident.
 *   2. It names the way back. A `pre_restore` snapshot is taken before the first
 *      delete, so the restore can itself be restored — and an operator who knows
 *      that panics less, and hurries less, than one who does not.
 *   3. The confirmation is typed, not clicked, and the word is checked here *and*
 *      in the service. The dialog's check is for the operator's benefit — the
 *      button stays disabled until the word matches — and the service's is the one
 *      that matters, because a dialog is client-side and a restore is not.
 */
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Button, Modal, TextInput } from "@/components/ui";
import { RESTORE_CONFIRMATION } from "../services/backupService";
import { formatBytes } from "../services/schedule";

export interface RestoreTarget {
  /** A stored snapshot… */
  id?: string;
  /** …or a file an admin picked. Exactly one of the two, as in the service. */
  fileText?: string;
  /** What the dialog calls the thing it is about to install. */
  label: string;
  /** Metadata for the summary line, when the source has any. */
  rows?: number;
  tables?: number;
  sizeBytes?: number;
  takenAt?: string | null;
  takenBy?: string | null;
}

export function RestoreDialog({
  target,
  busy,
  onClose,
  onConfirm,
}: {
  target: RestoreTarget | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: (confirmation: string) => void;
}) {
  const { t, date, num } = useI18n();
  const [typed, setTyped] = useState("");

  // A dialog that opens with yesterday's half-typed word is a dialog that can be
  // confirmed by accident, so the field starts empty every time.
  useEffect(() => {
    if (target) setTyped("");
  }, [target]);

  const matches = typed.trim().toUpperCase() === RESTORE_CONFIRMATION;

  return (
    <Modal
      open={Boolean(target)}
      onClose={busy ? () => undefined : onClose}
      title={t("backup.restore.title")}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={!matches}
            onClick={() => onConfirm(typed.trim())}
          >
            {t("backup.restore.submit")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3">
          <p className="text-sm font-bold text-rose-900">{t("backup.restore.warning")}</p>
          <p className="mt-1 text-xs text-rose-800">{target?.label}</p>
        </div>

        <ul className="space-y-2 text-sm text-slate-700">
          <li className="flex gap-2">
            <span aria-hidden className="mt-0.5 shrink-0 text-rose-500">•</span>
            <span>{t("backup.restore.point1")}</span>
          </li>
          <li className="flex gap-2">
            <span aria-hidden className="mt-0.5 shrink-0 text-rose-500">•</span>
            <span>
              {t("backup.restore.point2", {
                date: target?.takenAt ? date(target.takenAt) : t("backup.never"),
              })}
            </span>
          </li>
          <li className="flex gap-2">
            <span aria-hidden className="mt-0.5 shrink-0 text-emerald-600">•</span>
            <span>{t("backup.restore.point3")}</span>
          </li>
          <li className="flex gap-2">
            <span aria-hidden className="mt-0.5 shrink-0 text-emerald-600">•</span>
            <span>{t("backup.restore.point4")}</span>
          </li>
        </ul>

        {typeof target?.rows === "number" ? (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            {t("backup.restore.summary", {
              rows: num(target.rows),
              tables: num(target.tables ?? 0),
              size: formatBytes(target.sizeBytes ?? 0),
              date: target.takenAt ? date(target.takenAt) : t("backup.never"),
              by: target.takenBy || t("backup.unknownUser"),
            })}
          </p>
        ) : null}

        <div className="space-y-1.5">
          <label
            htmlFor="restore-confirmation"
            className="text-xs font-bold text-slate-800"
          >
            {t("backup.restore.confirmLabel", { word: RESTORE_CONFIRMATION })}
          </label>
          <TextInput
            id="restore-confirmation"
            value={typed}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder={t("backup.restore.confirmPlaceholder")}
            invalid={typed.length > 0 && !matches}
            disabled={busy}
            onChange={(event) => setTyped(event.target.value)}
          />
          {!matches && typed.length > 0 ? (
            <p className="text-[11px] font-medium text-rose-600">
              {t("backup.restore.mismatch")}
            </p>
          ) : null}
        </div>

        <div className="space-y-1 rounded-xl border border-slate-200 bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600">
          <p>{t("backup.restore.rollbackHint")}</p>
          <p>{t("backup.restore.reloadHint")}</p>
        </div>
      </div>
    </Modal>
  );
}
