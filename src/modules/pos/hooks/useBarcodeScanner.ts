import { useEffect, useRef } from "react";

const MAX_GAP_MS = 80;
const MIN_LENGTH = 3;

/** Normal text/select/contenteditable controls belong to the operator, not HID capture. */
export function isNormalTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const editable = target.closest("input,textarea,select,[contenteditable='true']");
  return Boolean(editable && !editable.hasAttribute("data-barcode-scanner-capture"));
}

/** Small deterministic decoder shared by the hook and scanner timing tests. */
export class BarcodeBurstDecoder {
  private buffer = "";
  private lastKeyAt = 0;
  private validBurst = true;

  reset(): void {
    this.buffer = "";
    this.lastKeyAt = 0;
    this.validBurst = true;
  }

  feed(key: string, now: number): string | null {
    if (key === "Enter") {
      const result = this.buffer.length >= MIN_LENGTH && this.validBurst ? this.buffer : null;
      this.reset();
      return result;
    }
    if (key.length !== 1) return null;
    if (this.lastKeyAt > 0 && now - this.lastKeyAt > MAX_GAP_MS) {
      this.buffer = "";
      this.validBurst = false;
    }
    if (this.lastKeyAt === 0) this.validBurst = true;
    this.buffer += key;
    this.lastKeyAt = now;
    return null;
  }
}

/**
 * Keyboard-wedge scanner listener. Only a fast printable burst terminated by
 * Enter is claimed. Normal form controls are completely excluded (the POS
 * search input has its own exact-code Enter handler), so customer names,
 * discounts, notes, PINs and settings never become accidental scans or get
 * cleared by this hook.
 */
export function useBarcodeScanner(onScan: (code: string) => void): void {
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  useEffect(() => {
    const decoder = new BarcodeBurstDecoder();
    const onKeyDown = (event: KeyboardEvent) => {
      if (isNormalTypingTarget(event.target)) {
        decoder.reset();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) {
        decoder.reset();
        return;
      }
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      const scan = decoder.feed(event.key, now);
      if (scan) {
        event.preventDefault();
        onScanRef.current(scan);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
