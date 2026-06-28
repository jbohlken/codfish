import { describe, it, expect } from "vitest";
import { resizePanelWidth } from "../PanelResizeHandle";

// dir +1 = handle on the panel's right edge (left-docked project panel):
// pointer moves right → wider. dir -1 = handle on the left edge (right-docked
// caption panel): pointer moves left (negative delta) → wider.
describe("resizePanelWidth", () => {
  const WIN = 2000; // wide enough that the half-window cap never bites here

  it("grows a right-edge handle as the pointer moves right", () => {
    expect(resizePanelWidth(220, 50, 1, 180, 560, WIN)).toBe(270);
  });

  it("grows a left-edge handle as the pointer moves left", () => {
    // clientX decreases while dragging left → negative delta, negated by dir.
    expect(resizePanelWidth(300, -40, -1, 220, 600, WIN)).toBe(340);
  });

  it("shrinks a left-edge handle as the pointer moves right", () => {
    expect(resizePanelWidth(300, 40, -1, 220, 600, WIN)).toBe(260);
  });

  it("clamps to the minimum", () => {
    expect(resizePanelWidth(220, -100, 1, 180, 560, WIN)).toBe(180);
  });

  it("clamps to the maximum", () => {
    expect(resizePanelWidth(540, 100, 1, 180, 560, WIN)).toBe(560);
  });

  it("never exceeds half the window, even below the configured max", () => {
    // window 700 → cap = round(350) = 350, tighter than max 560.
    expect(resizePanelWidth(300, 200, 1, 180, 560, 700)).toBe(350);
  });

  it("applies the half-window cap to a left-edge handle too", () => {
    expect(resizePanelWidth(300, -200, -1, 220, 600, 700)).toBe(350);
  });
});
