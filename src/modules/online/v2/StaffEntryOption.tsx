/**
 * The one control the hidden keyword reveals.
 *
 * Rendered by the V2 search surfaces only while `isStaffEntryQuery(search)` is
 * true — never on mount, never for another query — so the storefront keeps no
 * permanent entrance for customers. It is a real `<button>`, which is what makes
 * it work unchanged on a desktop keyboard, an Android touch screen and an
 * iPhone one: tap, click, Tab-then-Enter and the form's own Enter all reach the
 * same handler, and there is no hover-only affordance to be missed on touch.
 *
 * The styling borrows the shop's own tokens (`--v2-accent` gold, `--v2-surface`
 * ivory, `--v2-card-radius`) rather than introducing a second design language,
 * and it inherits the header's own colours when it sits inside the header.
 */
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useNavigate } from "react-router-dom";
import { V2Icon } from "./Primitives";
import { STAFF_ENTRY_ROUTE } from "./staffEntry";

export function V2StaffEntry({ onNavigate }: { onNavigate?: () => void } = {}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const open = () => {
    // Close whatever revealed it first: the header search row, or the catalog's
    // own field. Then a plain in-app navigation — no reload, no new tab, and
    // nothing a popup blocker can swallow.
    onNavigate?.();
    navigate(STAFF_ENTRY_ROUTE);
  };
  return (
    <div className="v2-staff-entry" data-testid="v2-staff-entry">
      <button type="button" className="v2-staff-entry-action" data-testid="v2-staff-entry-action" onClick={open}>
        <V2Icon name="user" />
        <span className="v2-staff-entry-copy">
          <span className="v2-staff-entry-label">{t("store.v2.staffEntry")}</span>
          <span className="v2-staff-entry-hint">{t("store.v2.staffEntryHint")}</span>
        </span>
        <V2Icon name="arrow" />
      </button>
    </div>
  );
}
