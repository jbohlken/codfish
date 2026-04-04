import type { ValidationWarning } from "../lib/pipeline/types";
import { showWarningTooltip, hideTooltip } from "./Tooltip";

export function WarningBadge({ warnings }: { warnings: ValidationWarning[] }) {
  const hasStrict = warnings.some(w => w.strict);
  const hasFuzzy  = warnings.some(w => !w.strict);

  const dotClass = hasStrict && hasFuzzy
    ? "warning-dot warning-dot--both"
    : hasStrict
      ? "warning-dot warning-dot--strict"
      : "warning-dot warning-dot--fuzzy";

  const rows = warnings.map(w => ({ label: w.label, detail: w.detail, strict: w.strict ?? false }));

  const handleMouseEnter = (e: MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    showWarningTooltip(rows, rect.left + rect.width / 2, rect.top, rect.bottom);
  };

  return (
    <span
      class="caption-warning"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={hideTooltip}
    >
      <span class={dotClass} />
    </span>
  );
}
