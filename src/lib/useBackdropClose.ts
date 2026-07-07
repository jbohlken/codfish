import { useRef } from "preact/hooks";

/** Click-on-backdrop-to-close, drag-safe. A text-selection drag that starts
 *  inside the panel and RELEASES over the backdrop fires the click event on
 *  the backdrop (the press/release common ancestor) — which must not close.
 *  Closing requires the press to have STARTED on the backdrop too.
 *  Spread the returned handlers onto the backdrop element. */
export function useBackdropClose(onClose: () => void): {
  onMouseDown: (e: Event) => void;
  onClick: (e: Event) => void;
} {
  const armed = useRef(false);
  return {
    onMouseDown: (e: Event) => {
      armed.current = e.target === e.currentTarget;
    },
    onClick: (e: Event) => {
      if (armed.current && e.target === e.currentTarget) onClose();
      armed.current = false;
    },
  };
}
