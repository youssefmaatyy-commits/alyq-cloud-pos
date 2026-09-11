import { useEffect, useRef } from "react";

/**
 * Barcode-scanner keyboard hook.
 *
 * Hand-held scanners act as HID keyboards: they "type" the code quickly
 * (inter-key delay ≈ 5–20ms) and finish with Enter. We detect that burst and
 * ignore slow human typing, so normal navigation is never hijacked.
 *
 * - ignored while the user is typing in an input / textarea / select
 * - a burst resets after 80ms of silence
 * - codes shorter than 3 characters are ignored (typos / noise)
 */
export function useBarcodeScanner(onScan: (code: string) => void): void {
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    let buffer = "";
    let lastKey = 0;

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (target.isContentEditable) return;
      }

      if (event.key === "Enter") {
        if (buffer.length >= 3) {
          onScanRef.current(buffer);
        }
        buffer = "";
        return;
      }

      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (now - lastKey > 80) buffer = "";
      lastKey = now;

      if (event.key.length === 1) {
        buffer += event.key;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
