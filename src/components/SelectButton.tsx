import { useEffect, useRef, useState } from "preact/hooks";
import { CaretDownIcon as CaretDown, DownloadSimpleIcon as DownloadSimple, type Icon } from "@phosphor-icons/react";
import type { ComponentChildren } from "preact";
import { openTitlebarMenu } from "./titlebarMenu";

export function SelectButton<T extends string>({
  icon: Icon,
  options,
  value,
  onChange,
  tooltip,
  direction = "down",
  footer,
  menuId,
}: {
  icon: Icon;
  tooltip: string;
  options: ({ value: T; label: string; menuLabel?: string; meta?: string; badge?: boolean } | { separator: true; label?: string })[];
  value: T;
  onChange: (value: T) => void;
  direction?: "up" | "down";
  footer?: (close: () => void) => ComponentChildren;
  /** When set, this dropdown joins the title-bar menu-bar group: only one such
   *  menu is open at a time and hovering across them swaps. Omit for standalone. */
  menuId?: string;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const [fixedPos, setFixedPos] = useState<{ bottom: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o): o is { value: T; label: string } => !("separator" in o) && o.value === value);

  const grouped = menuId !== undefined;
  const open = grouped ? openTitlebarMenu.value === menuId : localOpen;
  const setOpen = (next: boolean) => {
    if (grouped) openTitlebarMenu.value = next ? menuId! : null;
    else setLocalOpen(next);
  };

  // For an upward menu, capture the trigger rect so the fixed-position menu opens
  // above it. (Title-bar menus are "down" and skip this.)
  const captureUpPos = () => {
    if (direction === "up" && ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setFixedPos({ bottom: window.innerHeight - rect.top + 4, left: rect.left });
    }
  };

  const handleOpen = () => {
    if (!open) captureUpPos();
    setOpen(!open);
  };

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const menu = open && (
    <div
      class="titlebar-select-menu"
      style={fixedPos ? `position:fixed;bottom:${fixedPos.bottom}px;left:${fixedPos.left}px;top:auto;right:auto;width:max-content;min-width:0` : undefined}
    >
      {options.map((opt, i) =>
        "separator" in opt ? (
          <div key={`sep-${i}`}>
            <div class="titlebar-select-divider" />
            {opt.label && <div class="titlebar-select-group-label">{opt.label}</div>}
          </div>
        ) : (
          <button
            key={opt.value}
            class={`titlebar-select-option${opt.value === value ? " titlebar-select-option--active" : ""}`}
            onClick={() => { onChange(opt.value); setOpen(false); }}
          >
            <span class="titlebar-select-option-name">{opt.menuLabel ?? opt.label}</span>
            {(opt.meta || opt.badge) && (
              <span class="titlebar-select-option-meta">
                {opt.meta}
                {opt.badge && <DownloadSimple size={11} />}
              </span>
            )}
          </button>
        )
      )}
      {footer && (
        <>
          <div class="titlebar-select-divider" />
          {footer(() => setOpen(false))}
        </>
      )}
    </div>
  );

  return (
    <div class="titlebar-select" ref={ref}>
      <button
        class="titlebar-select-btn"
        data-tooltip={tooltip}
        onClick={handleOpen}
        onMouseEnter={grouped ? () => {
          // Menu-bar swap: if another title-bar menu is already open, hovering
          // this trigger switches to it.
          if (openTitlebarMenu.value !== null && openTitlebarMenu.value !== menuId) {
            captureUpPos();
            openTitlebarMenu.value = menuId!;
          }
        } : undefined}
      >
        <Icon size={13} />
        <span class="titlebar-select-label">{current?.label}</span>
        <CaretDown size={10} />
      </button>
      {menu}
    </div>
  );
}
