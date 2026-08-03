import { useEffect, useState } from "preact/hooks";
import type { FunctionComponent } from "preact";

type PanelProps = { onClose: () => void };

// Dev-only gate for the mediabunny evaluation panel (phase-0 spike).
// Ctrl+Shift+B toggles it. The panel module — and with it mediabunny and the
// ProRes/AC-3 decoder bundles — is imported lazily on first open, so none of
// it is loaded (or even fetched) until the hotkey is pressed, and the whole
// subtree is compiled out of production builds by the DEV guard in App.
export function MediaSpike() {
  const [Panel, setPanel] = useState<FunctionComponent<PanelProps> | null>(null);
  const [isOpen, setOpen] = useState(false);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const load = () => void import("./MediaSpikePanel").then((m) => setPanel(() => m.MediaSpikePanel));
    // Unattended battery runs: VITE_SPIKE_AUTO=1 opens the panel immediately;
    // the panel then runs all fixtures, saves RESULTS.md, and quits the app.
    if (import.meta.env.VITE_SPIKE_AUTO === "1") {
      setOpen(true);
      load();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.code === "KeyB") {
        e.preventDefault();
        setOpen((v) => !v);
        load();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!isOpen || !Panel) return null;
  return <Panel onClose={() => setOpen(false)} />;
}
