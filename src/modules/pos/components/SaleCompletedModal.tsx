import { useI18n } from "@/lib/i18n/I18nProvider";
import { Button, Modal, useToast } from "@/components/ui";
import { usePos } from "../hooks/PosProvider";
import { buildReceiptHtml } from "../services/receipt";

/**
 * Shown after a successful sale: the sale number, totals and a print action.
 * "New sale" clears the cart and closes the dialog; printing opens the
 * printable receipt in a popup (or an in-page frame when the popup is blocked).
 *
 * `writeAndPrint` writes the receipt HTML into a target window/frame and
 * triggers its print dialog once the document has loaded; `target.print` is
 * invoked exactly once.
 */
function writeAndPrint(target: Window & { print: () => void }, html: string, saleNumber: string) {
  const doc = target.document;
  // The receipt builder embeds an auto-print in the <body>; we strip it and
  // invoke print() ourselves once so the trigger is single and controlled.
  doc.open();
  doc.write(html.replace('onload="window.focus();window.print();"', ""));
  doc.close();

  let printed = false;
  const doPrint = () => {
    if (printed) return;
    printed = true;
    try {
      console.log("[receipt-print] invoking print()", { sale_number: saleNumber });
      target.focus();
      target.print();
    } catch (err) {
      console.error("[receipt-print] print() threw", {
        error: err instanceof Error ? err.message : err,
      });
    }
  };
  try {
    target.addEventListener("load", () => setTimeout(doPrint, 120));
  } catch {
    /* some browsers reject attaching to a fresh window — fallback timer below */
  }
  setTimeout(doPrint, 450);
}

export function SaleCompletedModal() {
  const { t, num } = useI18n();
  const { completedSale, dismissCompleted } = usePos();
  const toast = useToast();

  if (!completedSale) return null;

  const printReceipt = () => {
    // ── Trace: confirm the handler fires with the sale data present. ──
    console.log("[receipt-print] onClick fired", {
      sale_number: completedSale.sale_number,
      has_items: Boolean(completedSale.items?.length),
      total: completedSale.total,
      dir: document.documentElement.getAttribute("dir"),
    });

    if (!completedSale.sale_number || !completedSale.items?.length) {
      console.error("[receipt-print] abort: no completed sale / receipt data", { completedSale });
      toast.error(t("pos.printFailed"));
      return;
    }

    // On-screen confirmation that the handler ran and printing is being
    // attempted. This toast renders inside the app, so it is visible even
    // when the app runs in a sandboxed iframe whose console is not accessible.
    toast.success(t("pos.printing"));

    // Build the receipt HTML first (pure — never mutates the sale).
    const isRTL = document.documentElement.getAttribute("dir") === "rtl";
    let html: string;
    try {
      html = buildReceiptHtml({
        sale: completedSale,
        direction: isRTL ? "rtl" : "ltr",
        strings: {
          businessName: t("receipt.businessName"),
          businessTagline: t("receipt.businessTagline"),
          saleLabel: t("receipt.saleLabel"),
          dateLabel: t("receipt.dateLabel"),
          cashierLabel: t("receipt.cashierLabel"),
          itemLabel: t("receipt.itemLabel"),
          qtyLabel: t("receipt.qtyLabel"),
          priceLabel: t("receipt.priceLabel"),
          totalLabel: t("receipt.totalLabel"),
          subtotalLabel: t("receipt.subtotalLabel"),
          discountLabel: t("receipt.discountLabel"),
          paymentLabel: t("receipt.paymentLabel"),
          receivedLabel: t("receipt.receivedLabel"),
          changeLabel: t("receipt.changeLabel"),
          customerLabel: t("receipt.customerLabel"),
          customerPhoneLabel: t("receipt.customerPhoneLabel"),
          paidLabel: t("pos.paid"),
          remainingLabel: t("pos.remaining"),
          statusLabel: t("receipt.statusLabel"),
          thankYou: t("receipt.thankYou"),
          voidedNotice: t("receipt.voidedNotice"),
        },
      });
    } catch (err) {
      console.error("[receipt-print] failed to build receipt html", {
        sale_number: completedSale.sale_number,
        error: err instanceof Error ? err.message : err,
      });
      toast.error(t("pos.printFailed"));
      return;
    }
    console.log("[receipt-print] html built", { bytes: html.length, has_svg: html.includes("<svg") });

    // Attempt the print via a top-level popup first (works in a normal tab,
    // and gives a real top-level print dialog). A hidden same-document iframe
    // is the fallback. Detect an embedded/sandboxed context so we can explain
    // why a native dialog cannot open instead of failing silently.
    const isEmbedded = typeof window !== "undefined" && window.self !== window.top;
    let w: Window | null = null;
    try {
      w = window.open("", "_blank", "width=420,height=640");
    } catch (err) {
      console.error("[receipt-print] window.open() threw", {
        error: err instanceof Error ? err.message : err,
      });
      w = null;
    }
    if (w) {
      try {
        writeAndPrint(w as Window & { print: () => void }, html, completedSale.sale_number);
        return;
      } catch (err) {
        console.error("[receipt-print] popup write failed, trying in-page frame", {
          sale_number: completedSale.sale_number,
          error: err instanceof Error ? err.message : err,
        });
        try {
          w.close();
        } catch {
          /* ignore */
        }
      }
    }

    // The popup was blocked/unavailable. If the app itself is running inside a
    // sandboxed/embedded iframe (e.g. a preview pane), the browser will also
    // suppress a native print dialog — no JavaScript can open one there. Tell
    // the user clearly and stop (the hidden-frame attempt below is for the
    // normal top-level case where only the popup was blocked).
    if (isEmbedded) {
      console.error(
        "[receipt-print] blocked: native print dialog cannot open inside an embedded/sandboxed frame",
        { sale_number: completedSale.sale_number },
      );
      toast.error(t("pos.printEmbedded"));
      return;
    }

    // Fallback for the normal (non-embedded) case: print the receipt in a
    // hidden, same-document iframe so we never depend on a separate popup.
    console.log("[receipt-print] popup unavailable, using hidden in-page frame", {
      sale_number: completedSale.sale_number,
    });
    let frame: HTMLIFrameElement | null = null;
    try {
      frame = document.createElement("iframe");
      frame.setAttribute(
        "style",
        "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;visibility:hidden;",
      );
      frame.setAttribute("aria-hidden", "true");
      frame.setAttribute("tabindex", "-1");
      document.body.appendChild(frame);
      const inner = frame.contentWindow;
      if (!inner) throw new Error("iframe contentWindow unavailable");
      writeAndPrint(inner as Window & { print: () => void }, html, completedSale.sale_number);
    } catch (err) {
      console.error("[receipt-print] failed to print receipt", {
        sale_number: completedSale.sale_number,
        error: err instanceof Error ? err.message : err,
      });
      try {
        frame?.remove();
      } catch {
        /* ignore */
      }
      // The browser forbids printing here (e.g. sandboxed/embedded context).
      toast.error(t("barcode.printBlocked"));
    }
  };

  return (
    <Modal
      open={Boolean(completedSale)}
      onClose={dismissCompleted}
      title={t("pos.saleCompleted")}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={dismissCompleted}>
            {t("pos.newSale")}
          </Button>
          <Button onClick={printReceipt}>🖨 {t("pos.printReceipt")}</Button>
        </>
      }
    >
      <div className="space-y-3 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-2xl">
          ✓
        </div>
        <div>
          <p className="text-lg font-extrabold tracking-wide text-slate-900">
            {completedSale.sale_number}
          </p>
          <p className="mt-1 text-2xl font-extrabold tabular-nums text-slate-900">
            {num(completedSale.total, 2)}
          </p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5">
            {completedSale.payments.map((p) => (
              <span
                key={p.id}
                className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700"
              >
                {t(`pos.payment.${p.method}`)} · {num(p.amount, 2)}
                {p.method === "instapay" && p.status === "pending"
                  ? ` · ${t("pos.instapay.pending")}`
                  : ""}
              </span>
            ))}
          </div>
          {completedSale.change != null ? (
            <p className="mt-1 text-xs font-semibold text-slate-500">
              {t("pos.change")}: {num(completedSale.change, 2)}
            </p>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
