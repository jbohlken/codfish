import { describe, it, expect } from "vitest";
import { sortMedia } from "../mediaSort";
import type { MediaItem } from "../../types/project";

// Minimal MediaItem factory — only the fields the sort touches matter.
function m(name: string, opts: { addedAt?: string } = {}): MediaItem {
  return {
    id: name,
    name,
    path: `C:/media/${name}`,
    fps: null,
    captions: [],
    exports: [],
    ...(opts.addedAt ? { addedAt: opts.addedAt } : {}),
  };
}

const names = (items: MediaItem[]) => items.map((i) => i.name);

describe("sortMedia — date added", () => {
  it("default added+asc reproduces array order for all-unstamped (legacy) media", () => {
    const list = [m("c"), m("a"), m("b")];
    expect(names(sortMedia(list, "added", "asc"))).toEqual(["c", "a", "b"]);
  });

  it("orders stamped items chronologically", () => {
    const list = [
      m("late", { addedAt: "2026-03-01T00:00:00Z" }),
      m("early", { addedAt: "2026-01-01T00:00:00Z" }),
      m("mid", { addedAt: "2026-02-01T00:00:00Z" }),
    ];
    expect(names(sortMedia(list, "added", "asc"))).toEqual(["early", "mid", "late"]);
    expect(names(sortMedia(list, "added", "desc"))).toEqual(["late", "mid", "early"]);
  });

  it("ranks unstamped (legacy) items before stamped ones in ascending order", () => {
    const list = [
      m("new", { addedAt: "2026-05-01T00:00:00Z" }),
      m("legacy1"),
      m("legacy2"),
    ];
    // Asc: unstamped first (older), in array order; stamped after.
    expect(names(sortMedia(list, "added", "asc"))).toEqual(["legacy1", "legacy2", "new"]);
    // Desc: newest stamped first, then legacy in reverse import order.
    expect(names(sortMedia(list, "added", "desc"))).toEqual(["new", "legacy2", "legacy1"]);
  });

  it("legacy (all-unstamped) media reverses with direction, using import order as the added proxy", () => {
    const list = [m("first"), m("second"), m("third")];
    expect(names(sortMedia(list, "added", "asc"))).toEqual(["first", "second", "third"]);
    expect(names(sortMedia(list, "added", "desc"))).toEqual(["third", "second", "first"]);
  });

  it("date added is a total order — direction reverses same-timestamp items too", () => {
    const ts = "2026-01-01T00:00:00Z";
    const list = [m("A", { addedAt: ts }), m("B", { addedAt: ts }), m("C", { addedAt: ts })];
    expect(names(sortMedia(list, "added", "asc"))).toEqual(["A", "B", "C"]);
    expect(names(sortMedia(list, "added", "desc"))).toEqual(["C", "B", "A"]);
  });

  it("does not mutate the input array", () => {
    const list = [m("b", { addedAt: "2026-02-01T00:00:00Z" }), m("a", { addedAt: "2026-01-01T00:00:00Z" })];
    const before = names(list);
    sortMedia(list, "added", "asc");
    expect(names(list)).toEqual(before);
  });
});

describe("sortMedia — name", () => {
  it("sorts naturally (numeric), not lexicographically", () => {
    const list = [m("Ep10"), m("Ep2"), m("Ep1")];
    expect(names(sortMedia(list, "name", "asc"))).toEqual(["Ep1", "Ep2", "Ep10"]);
    expect(names(sortMedia(list, "name", "desc"))).toEqual(["Ep10", "Ep2", "Ep1"]);
  });

  it("case-only-different names keep import order in both directions (stable tiebreak)", () => {
    const list = [m("TAKE1"), m("take1")];
    expect(names(sortMedia(list, "name", "asc"))).toEqual(["TAKE1", "take1"]);
    expect(names(sortMedia(list, "name", "desc"))).toEqual(["TAKE1", "take1"]);
  });
});
