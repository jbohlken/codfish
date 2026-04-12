import { signal } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";

interface TextTooltip {
  type: "text";
  text: string;
  x: number;
  y: number;
  anchorBottom: number;
}

interface RowsTooltip {
  type: "rows";
  lines?: string[];
  rows: { label: string; detail: string; strict?: boolean }[];
  x: number;
  y: number;
  anchorBottom: number;
}

type TooltipState = TextTooltip | RowsTooltip;

const tooltipState = signal<TooltipState | null>(null);
let pendingDelay: ReturnType<typeof setTimeout> | null = null;

export function showWarningTooltip(
  rows: { label: string; detail: string; strict?: boolean }[],
  x: number,
  y: number,
  anchorBottom: number,
) {
  tooltipState.value = { type: "rows", rows, x, y, anchorBottom };
}

/**
 * Imperatively show a plain-text tooltip at the given coordinates.
 * Used by components that can't put `data-tooltip` on the actual hovered
 * element (e.g. tokens behind a textarea overlay).
 */
export function showTextTooltip(text: string, x: number, y: number, anchorBottom: number) {
  if (pendingDelay !== null) {
    clearTimeout(pendingDelay);
    pendingDelay = null;
  }
  tooltipState.value = { type: "text", text, x, y, anchorBottom };
}

export function showBlockTooltip(
  lines: string[],
  rows: { label: string; detail: string; strict?: boolean }[],
  x: number,
  y: number,
  anchorBottom: number,
) {
  tooltipState.value = { type: "rows", lines, rows, x, y, anchorBottom };
}

export function hideTooltip() {
  if (pendingDelay !== null) {
    clearTimeout(pendingDelay);
    pendingDelay = null;
  }
  tooltipState.value = null;
}

export function Tooltip() {
  useEffect(() => {
    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest("[data-tooltip]") as HTMLElement | null;
      if (!el) return;
      const text = el.getAttribute("data-tooltip") ?? "";
      if (!text) return;
      pendingDelay = setTimeout(() => {
        const rect = el.getBoundingClientRect();
        tooltipState.value = {
          type: "text",
          text,
          x: rect.left + rect.width / 2,
          y: rect.top,
          anchorBottom: rect.bottom,
        };
      }, 600);
    };

    const onOut = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest("[data-tooltip]");
      if (!el) return;
      hideTooltip();
    };

    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    return () => {
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      hideTooltip();
    };
  }, []);

  const state = tooltipState.value;
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !state) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;

    // Horizontal clamping
    if (rect.right > window.innerWidth - pad) {
      el.style.left = `${window.innerWidth - pad - rect.width / 2}px`;
    } else if (rect.left < pad) {
      el.style.left = `${pad + rect.width / 2}px`;
    }

    // Vertical flip: if tooltip clips above viewport, show below anchor instead
    if (rect.top < pad) {
      el.style.top = `${state.anchorBottom + 8}px`;
      el.style.transform = "translateX(-50%)";
    }
  }, [state]);

  if (!state) return null;

  return (
    <div ref={ref} class="tooltip" style={{ left: `${state.x}px`, top: `${state.y}px` }}>
      {state.type === "text" ? (
        state.text.split("\n").map((line, i) => <div key={i}>{line}</div>)
      ) : (
        <>
          {state.lines?.map((line, i) => (
            <div key={i} class="tooltip-line">{line}</div>
          ))}
          {state.lines && state.rows.length > 0 && (
            <div class="tooltip-divider" />
          )}
          {state.rows.map((row, i) => (
            <div key={i} class="tooltip-row">
              <span class="tooltip-row-left">
                {row.strict !== undefined && (
                  <span class={`tooltip-row-dot tooltip-row-dot--${row.strict ? "strict" : "fuzzy"}`} />
                )}
                <span class="tooltip-row-label">{row.label}</span>
              </span>
              <span class="tooltip-row-detail">{row.detail}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
