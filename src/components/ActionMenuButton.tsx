import { useEffect, useRef, useState } from "preact/hooks";
import { CaretDownIcon as CaretDown, type Icon } from "@phosphor-icons/react";
import { openTitlebarMenu } from "./titlebarMenu";

export interface ActionMenuItem {
  label: string;
  meta?: string;           // muted text on the right, e.g. a count
  description?: string;    // muted second line explaining scope
  danger?: boolean;        // destructive styling (red)
  disabled?: boolean;
  disabledReason?: string; // tooltip shown when disabled
  onClick: () => void;
}

/** A scope divider with an optional uppercase group label (e.g. "Selection"). */
export interface ActionMenuSeparator {
  separator: true;
  label?: string;
}

export type ActionMenuEntry = ActionMenuItem | ActionMenuSeparator;

const isSeparator = (e: ActionMenuEntry): e is ActionMenuSeparator => "separator" in e;

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
  menuId,
}: {
  icon: Icon;
  label: string;
  tooltip?: string;
  items: ActionMenuEntry[];
  /** When set, joins the title-bar menu-bar group (single-owner + hover-swap). */
  menuId?: string;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const grouped = menuId !== undefined;
  const open = grouped ? openTitlebarMenu.value === menuId : localOpen;
  const setOpen = (next: boolean) => {
    if (grouped) openTitlebarMenu.value = next ? menuId! : null;
    else setLocalOpen(next);
  };

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
        onClick={() => setOpen(!open)}
        onMouseEnter={grouped ? () => {
          // Menu-bar swap: hovering this trigger while another title-bar menu is
          // open switches to it.
          if (openTitlebarMenu.value !== null && openTitlebarMenu.value !== menuId) {
            openTitlebarMenu.value = menuId!;
          }
        } : undefined}
      >
        <Icon size={13} />
        <span class="titlebar-select-label">{label}</span>
        <CaretDown size={10} />
      </button>
      {open && (
        <div class="titlebar-select-menu">
          {items.map((item, i) =>
            isSeparator(item) ? (
              // Group label for a scope; the divider above it only when it's not
              // the first entry (so the top group has no leading rule).
              <div key={i}>
                {i > 0 && <div class="titlebar-select-divider" />}
                {item.label && <div class="titlebar-select-group-label">{item.label}</div>}
              </div>
            ) : (
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
            )
          )}
        </div>
      )}
    </div>
  );
}
