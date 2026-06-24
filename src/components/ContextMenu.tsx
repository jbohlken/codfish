import { signal } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { CaretRightIcon as CaretRight } from "@phosphor-icons/react";
import type { ComponentChildren } from "preact";

export interface ContextMenuItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  /** Optional leading icon, rendered before the label. */
  icon?: ComponentChildren;
  /** Nesting level for tree-shaped pickers (e.g. "Move to bin"): indents the
   *  row by this many steps so the hierarchy reads at a glance. */
  indent?: number;
  /** Action to run on click. Omitted for items that only open a submenu. */
  onClick?: () => void;
  /** When present, the item opens a flyout of these instead of acting. */
  submenu?: ContextMenuItem[];
}

// Pixels per indent level for tree-shaped menus, added to the item's base
// left padding.
const MENU_INDENT_STEP = 16;

/** Render an item's leading icon (if any) + its label. Shared by the root menu
 *  and submenu flyouts so both pick up icons and indentation. */
function ItemBody({ item }: { item: ContextMenuItem }) {
  return (
    <>
      {item.icon && <span class="context-menu-item-icon">{item.icon}</span>}
      <span class="context-menu-item-label">{item.label}</span>
    </>
  );
}

/** Inline left-padding override for an indented item, or undefined. */
function indentStyle(item: ContextMenuItem) {
  return item.indent
    ? { paddingLeft: `calc(var(--space-3) + ${item.indent * MENU_INDENT_STEP}px)` }
    : undefined;
}

interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

export const contextMenu = signal<ContextMenuState | null>(null);

export function showContextMenu(e: MouseEvent, items: ContextMenuItem[]) {
  e.preventDefault();
  e.stopPropagation();
  contextMenu.value = { x: e.clientX, y: e.clientY, items };
}

export function ContextMenu() {
  const state = contextMenu.value;
  const ref = useRef<HTMLDivElement>(null);
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!state) return;
    const close = () => { contextMenu.value = null; };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [state]);

  // Reset the open submenu whenever the menu itself changes.
  useEffect(() => { setOpenIndex(null); }, [state]);

  // Adjust position so menu doesn't overflow viewport
  useEffect(() => {
    if (!state || !ref.current) return;
    const el = ref.current;
    const { innerWidth, innerHeight } = window;
    if (el.offsetLeft + el.offsetWidth > innerWidth) {
      el.style.left = `${innerWidth - el.offsetWidth - 4}px`;
    }
    if (el.offsetTop + el.offsetHeight > innerHeight) {
      el.style.top = `${innerHeight - el.offsetHeight - 4}px`;
    }
  }, [state]);

  if (!state) return null;

  const close = () => { contextMenu.value = null; };

  return (
    <div
      ref={ref}
      class="context-menu"
      style={{ left: state.x, top: state.y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {state.items.map((item, i) =>
        item.submenu ? (
          <div
            key={i}
            class="context-menu-row"
            onMouseEnter={() => setOpenIndex(i)}
          >
            <button
              class={`context-menu-item context-menu-item--parent ${item.danger ? "context-menu-item--danger" : ""}`}
              disabled={item.disabled}
            >
              <span>{item.label}</span>
              <CaretRight size={12} />
            </button>
            {openIndex === i && item.submenu.length > 0 && (
              <Submenu items={item.submenu} onClose={close} />
            )}
          </div>
        ) : (
          <button
            key={i}
            class={`context-menu-item ${item.danger ? "context-menu-item--danger" : ""}`}
            style={indentStyle(item)}
            disabled={item.disabled}
            // Hovering a non-submenu sibling closes any open flyout.
            onMouseEnter={() => setOpenIndex(null)}
            onClick={() => { close(); item.onClick?.(); }}
          >
            <ItemBody item={item} />
          </button>
        )
      )}
    </div>
  );
}

/** Flyout for a submenu. Positioned by CSS to the right of its parent row,
 *  then nudged on mount to stay within the viewport (flip left on right-edge
 *  overflow; shift up on bottom-edge overflow). */
function Submenu({ items, onClose }: { items: ContextMenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 4;
    if (rect.right > window.innerWidth - pad) {
      el.style.left = "auto";
      el.style.right = "100%";
      el.style.marginLeft = "0";
      el.style.marginRight = "2px";
    }
    const overflowY = rect.bottom - (window.innerHeight - pad);
    if (overflowY > 0) el.style.top = `${el.offsetTop - overflowY}px`;
  }, []);

  return (
    <div ref={ref} class="context-menu context-menu-submenu">
      {items.map((sub, j) => (
        <button
          key={j}
          class={`context-menu-item ${sub.danger ? "context-menu-item--danger" : ""}`}
          style={indentStyle(sub)}
          disabled={sub.disabled}
          onClick={() => { onClose(); sub.onClick?.(); }}
        >
          <ItemBody item={sub} />
        </button>
      ))}
    </div>
  );
}
