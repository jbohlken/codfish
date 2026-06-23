import { describe, it, expect } from "vitest";
import { groupMediaByBin, rangeSelect } from "../bins";
import type { Bin, MediaItem } from "../../types/project";

function m(id: string, binId?: string): MediaItem {
  return { id, name: id, path: `C:/media/${id}`, fps: null, captions: [], exports: [], ...(binId ? { binId } : {}) };
}
const bin = (id: string, name = id): Bin => ({ id, name });
const ids = (items: MediaItem[]) => items.map((i) => i.id);

describe("groupMediaByBin", () => {
  it("returns a single ungrouped group when there are no bins", () => {
    const media = [m("a"), m("b"), m("c")];
    const groups = groupMediaByBin(media, []);
    expect(groups).toHaveLength(1);
    expect(groups[0].bin).toBeNull();
    expect(ids(groups[0].items)).toEqual(["a", "b", "c"]);
  });

  it("returns nothing when there are no bins and no media", () => {
    expect(groupMediaByBin([], [])).toEqual([]);
  });

  it("buckets media by bin in bins[] order, preserving item order, ungrouped last", () => {
    const bins = [bin("b1", "One"), bin("b2", "Two")];
    const media = [m("x", "b2"), m("y", "b1"), m("z"), m("w", "b2")];
    const groups = groupMediaByBin(media, bins);
    expect(groups.map((g) => g.bin?.id ?? "ungrouped")).toEqual(["b1", "b2", "ungrouped"]);
    expect(ids(groups[0].items)).toEqual(["y"]);          // b1
    expect(ids(groups[1].items)).toEqual(["x", "w"]);     // b2, input order kept
    expect(ids(groups[2].items)).toEqual(["z"]);          // ungrouped
  });

  it("includes empty bins (so they stay visible) and omits an empty ungrouped group", () => {
    const bins = [bin("b1"), bin("b2")];
    const media = [m("only", "b1")];
    const groups = groupMediaByBin(media, bins);
    expect(groups.map((g) => g.bin?.id)).toEqual(["b1", "b2"]); // both bins, no ungrouped
    expect(groups[1].items).toEqual([]);
  });

  it("treats an orphaned binId (no matching bin) as ungrouped", () => {
    const groups = groupMediaByBin([m("a", "gone"), m("b", "b1")], [bin("b1")]);
    expect(ids(groups[0].items)).toEqual(["b"]);
    expect(groups[1].bin).toBeNull();
    expect(ids(groups[1].items)).toEqual(["a"]);
  });
});

describe("rangeSelect", () => {
  const order = ["a", "b", "c", "d", "e"];
  it("returns the inclusive forward range", () => {
    expect(rangeSelect(order, "b", "d")).toEqual(["b", "c", "d"]);
  });
  it("returns the inclusive range regardless of direction", () => {
    expect(rangeSelect(order, "d", "b")).toEqual(["b", "c", "d"]);
  });
  it("returns a single id when anchor === target", () => {
    expect(rangeSelect(order, "c", "c")).toEqual(["c"]);
  });
  it("falls back to just the target when an id is missing", () => {
    expect(rangeSelect(order, "zzz", "c")).toEqual(["c"]);
  });
});
