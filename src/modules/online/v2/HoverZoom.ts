import type { MouseEvent as ReactMouseEvent } from "react";

/**
 * In-place hover zoom: while the pointer is over the photo the whole image is
 * enlarged inside its frame, and the zoom origin follows the pointer so every
 * part of the picture can be reached by moving the mouse.
 *
 * Nothing re-renders — the handlers only set a data attribute and two CSS
 * variables on the frame, and `storefront-v2.css` does the scaling. Pointer
 * devices only: the CSS rules sit behind `(hover: hover) and (pointer: fine)`,
 * so a tap on touch screens still just opens the full-size viewer.
 */
export const hoverZoomHandlers = {
  onMouseEnter(event: ReactMouseEvent<HTMLElement>) {
    event.currentTarget.dataset.zooming = "true";
  },
  onMouseMove(event: ReactMouseEvent<HTMLElement>) {
    const frame = event.currentTarget;
    const box = frame.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const x = Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1) * 100;
    const y = Math.min(Math.max((event.clientY - box.top) / box.height, 0), 1) * 100;
    frame.style.setProperty("--zoom-x", `${x.toFixed(2)}%`);
    frame.style.setProperty("--zoom-y", `${y.toFixed(2)}%`);
  },
  onMouseLeave(event: ReactMouseEvent<HTMLElement>) {
    const frame = event.currentTarget;
    delete frame.dataset.zooming;
    frame.style.removeProperty("--zoom-x");
    frame.style.removeProperty("--zoom-y");
  },
};
