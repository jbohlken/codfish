import type { ValidationWarning } from "../lib/pipeline/types";
import { showWarningTooltip, hideTooltip } from "./Tooltip";

// The caption's index doubles as its warning indicator: when warned, the number
// sits in a coloured pill — red for a strict error, amber for a soft warning,
// split red/amber when it has both — with the full warning list on hover.
// Living on the always-present number means no separate badge or reserved slot,
// and only warned rows get the pill, so unwarned rows keep a plain flush-left
// number and nothing shifts the row or hides behind the action overlay.
export function CaptionNumber({ index, warnings }: { index: number; warnings: ValidationWarning[] }) {
  if (warnings.length === 0) {
    return <span class="caption-num">#{index}</span>;
  }

  const hasStrict = warnings.some((w) => w.strict);
  const hasFuzzy = warnings.some((w) => !w.strict);
  const cls = hasStrict && hasFuzzy
    ? "caption-num caption-num--badge caption-num--both"
    : hasStrict
      ? "caption-num caption-num--badge caption-num--strict"
      : "caption-num caption-num--badge caption-num--fuzzy";

  const rows = warnings.map((w) => ({ label: w.label, detail: w.detail, strict: w.strict ?? false }));
  const handleMouseEnter = (e: MouseEvent) => {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    showWarningTooltip(rows, rect.left + rect.width / 2, rect.top, rect.bottom, el);
  };

  return (
    <span class={cls} onMouseEnter={handleMouseEnter} onMouseLeave={hideTooltip}>
      #{index}
    </span>
  );
}
