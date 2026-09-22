import { useEffect, useRef } from "react";

/** Keyboard-wedge scanner listener. It only claims a rapid burst (or Enter
 * suffix), leaving ordinary search, customer and discount typing untouched. */
export function useBarcodeScanner(onScan: (code: string) => void): void {
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  useEffect(() => {
    let buffer = "";
    let lastKey = 0;
    let burst = true;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
      const editable = Boolean(target && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable));
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (now - lastKey > 80) { buffer = ""; burst = true; }
      if (event.key === "Enter") {
        if (buffer.length >= 3 && burst) {
          event.preventDefault();
          onScanRef.current(buffer);
          if (target && "value" in target && target.tagName !== "SELECT") {
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), "value")?.set;
            setter?.call(target, "");
            target.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
        buffer = ""; lastKey = 0; burst = true;
        return;
      }
      if (event.key.length !== 1) return;
      if (now - lastKey > 80) buffer = "";
      if (now - lastKey > 80 && editable) burst = true;
      if (lastKey && now - lastKey > 80) burst = false;
      lastKey = now;
      buffer += event.key;
      // Do not intercept ordinary typing; only Enter turns a burst into a scan.
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
