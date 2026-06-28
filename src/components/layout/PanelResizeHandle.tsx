import { useEffect } from "preact/hooks";

// ── Panel resizing ──────────────────────────────────────────────────────────
// Drag-to-resize handle for a docked side panel. It lives inside the panel's
// header — which spans the panel's full width, so the header's width IS the
// panel width — and drives a CSS custom property on <html> that the
// .main-panels grid reads for the column track. Width is persisted per-user;
// double-click resets to the stylesheet default.
//
// `edge` is which edge of the panel the handle sits on: "right" for a
// left-docked panel (drag right to grow), "left" for a right-docked panel
// (drag left to grow). The pointer delta is signed accordingly.

// Both side panels share one min/max so they stay symmetric — the user dials
// each panel's width independently between these bounds, starting from the
// --panel-default-width CSS var. MIN is large enough that the project panel's
// header (its title + up to five action buttons) never clips.
export const PANEL_WIDTH_MIN = 240;
export const PANEL_WIDTH_MAX = 600;

function applyWidth(cssVar: string, px: number | null) {
  const root = document.documentElement;
  if (px === null) root.style.removeProperty(cssVar);
  else root.style.setProperty(cssVar, `${px}px`);
}

/** Clamp a drag to a new panel width. `dir` is +1 when the handle is on the
 *  panel's right edge (pointer moves right → wider) and -1 on the left edge
 *  (pointer moves left → wider). Never wider than half the window, even on
 *  small screens. Pure so the off-by-sign math is unit-testable. */
export function resizePanelWidth(
  startWidth: number,
  deltaX: number,
  dir: 1 | -1,
  min: number,
  max: number,
  windowWidth: number,
): number {
  const cap = Math.min(max, Math.round(windowWidth / 2));
  return Math.max(min, Math.min(cap, startWidth + dir * deltaX));
}

export function PanelResizeHandle({
  cssVar,
  storageKey,
  edge,
  min = PANEL_WIDTH_MIN,
  max = PANEL_WIDTH_MAX,
}: {
  /** CSS custom property the grid reads for this panel's column track. */
  cssVar: string;
  /** localStorage key the chosen width persists under. */
  storageKey: string;
  edge: "left" | "right";
  min?: number;
  max?: number;
}) {
  useEffect(() => {
    const stored = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(stored) && stored >= min && stored <= max) {
      // Re-apply the same half-window cap the drag enforces, so a width saved
      // on a wide monitor can't swallow a narrower window on next launch.
      applyWidth(cssVar, Math.min(stored, Math.round(window.innerWidth / 2)));
    }
    // Safety net: if the handle unmounts mid-drag (onUp never fires), don't
    // leave the global drag cursor / text-selection lock stuck on <body>.
    return () => document.body.classList.remove("col-resizing");
  }, [cssVar, storageKey, min, max]);

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const handle = e.currentTarget as HTMLElement;
    // The handle lives in the panel header, which spans the panel's full
    // width — so its width is the panel width.
    const host = handle.parentElement;
    if (!host) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("col-resizing");
    // Light up only THIS handle's accent line — the body.col-resizing cursor
    // is global, but the line is per-handle so the idle panel's edge stays dark.
    handle.classList.add("panel-resize-handle--dragging");

    const dir = edge === "right" ? 1 : -1;
    const startX = e.clientX;
    const startWidth = host.getBoundingClientRect().width;
    let width = startWidth;

    const onMove = (ev: PointerEvent) => {
      width = resizePanelWidth(startWidth, ev.clientX - startX, dir, min, max, window.innerWidth);
      applyWidth(cssVar, width);
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("col-resizing");
      handle.classList.remove("panel-resize-handle--dragging");
      localStorage.setItem(storageKey, String(Math.round(width)));
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  return (
    <div
      class={edge === "left" ? "panel-resize-handle panel-resize-handle--left" : "panel-resize-handle"}
      onPointerDown={onPointerDown}
      onDblClick={() => {
        applyWidth(cssVar, null);
        localStorage.removeItem(storageKey);
      }}
    />
  );
}
