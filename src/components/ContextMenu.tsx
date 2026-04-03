import { signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";

export interface ContextMenuItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
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

  return (
    <div
      ref={ref}
      class="context-menu"
      style={{ left: state.x, top: state.y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {state.items.map((item, i) => (
        <button
          key={i}
          class={`context-menu-item ${item.danger ? "context-menu-item--danger" : ""}`}
          disabled={item.disabled}
          onClick={() => {
            contextMenu.value = null;
            item.onClick();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
