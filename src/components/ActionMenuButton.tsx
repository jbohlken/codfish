import { useEffect, useRef, useState } from "preact/hooks";
import { CaretDownIcon as CaretDown, type Icon } from "@phosphor-icons/react";

export interface ActionMenuItem {
  label: string;
  meta?: string;           // muted text on the right, e.g. a count
  description?: string;    // muted second line explaining scope
  danger?: boolean;        // destructive styling (red)
  disabled?: boolean;
  disabledReason?: string; // tooltip shown when disabled
  onClick: () => void;
}

/** A header button that opens a small menu of actions. Visually matches the
 * SelectButton dropdowns, but triggers actions instead of selecting a value.
 *
 * Note: there is no trigger-level `disabled` prop — when the app is in a
 * state where this button shouldn't be usable (e.g. batch generation in
 * flight), the entire app-shell is inert via App.tsx and the BatchBlocker
 * takes over. Per-item disabling for project-state reasons (no media
 * selected, no captioned media, etc.) goes through `ActionMenuItem.disabled`
 * + `disabledReason`. */
export function ActionMenuButton({
  icon: Icon,
  label,
  tooltip,
  items,
}: {
  icon: Icon;
  label: string;
  tooltip?: string;
  items: ActionMenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div class="titlebar-select" ref={ref}>
      <button
        class="titlebar-select-btn titlebar-select-btn--action"
        data-tooltip={tooltip}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon size={13} />
        <span class="titlebar-select-label">{label}</span>
        <CaretDown size={10} />
      </button>
      {open && (
        <div class="titlebar-select-menu">
          {items.map((item, i) => (
            <button
              key={i}
              class={`titlebar-select-option${item.danger ? " titlebar-select-option--danger" : ""}`}
              disabled={item.disabled}
              data-tooltip={item.disabled ? item.disabledReason : undefined}
              onClick={() => { setOpen(false); item.onClick(); }}
            >
              <span class="titlebar-select-option-text">
                <span class="titlebar-select-option-name">{item.label}</span>
                {item.description && <span class="titlebar-select-option-desc">{item.description}</span>}
              </span>
              {item.meta && <span class="titlebar-select-option-meta">{item.meta}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
