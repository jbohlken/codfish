import { describe, it, expect } from "vitest";
import { buildBinForest, sortBins, collectSubtree, isDescendant, rangeSelect, planItemMove } from "../bins";
import type { BinNode } from "../bins";
import type { Bin, MediaItem } from "../../types/project";

function m(id: string, binId?: string): MediaItem {
  return { id, name: id, path: `C:/media/${id}`, fps: null, captions: [], exports: [], ...(binId ? { binId } : {}) };
}
const bin = (id: string, parentId?: string, extra: Partial<Bin> = {}): Bin =>
  ({ id, name: id, ...(parentId ? { parentId } : {}), ...extra });
const ids = (items: MediaItem[]) => items.map((i) => i.id);
// Flatten a forest into "binId>childBinId..." plus its direct media, for terse assertions.
const binIds = (nodes: BinNode[]): string[] => nodes.flatMap((n) => [n.bin.id, ...binIds(n.children)]);

describe("buildBinForest", () => {
  it("returns everything ungrouped when there are no bins", () => {
    const media = [m("a"), m("b"), m("c")];
    const forest = buildBinForest(media, []);
    expect(forest.roots).toEqual([]);
    expect(ids(forest.ungrouped)).toEqual(["a", "b", "c"]);
  });

  it("buckets media into their bins, preserving input order, rest ungrouped", () => {
    const bins = [bin("b1"), bin("b2")];
    const media = [m("x", "b2"), m("y", "b1"), m("z"), m("w", "b2")];
    const forest = buildBinForest(media, bins);
    expect(binIds(forest.roots)).toEqual(["b1", "b2"]);
    expect(ids(forest.roots[0].items)).toEqual(["y"]);       // b1
    expect(ids(forest.roots[1].items)).toEqual(["x", "w"]);  // b2, input order kept
    expect(ids(forest.ungrouped)).toEqual(["z"]);
  });

  it("keeps empty bins (so they stay visible) with no ungrouped group object", () => {
    const forest = buildBinForest([m("only", "b1")], [bin("b1"), bin("b2")]);
    expect(binIds(forest.roots)).toEqual(["b1", "b2"]);
    expect(forest.roots[1].items).toEqual([]);
    expect(forest.ungrouped).toEqual([]);
  });

  it("treats an orphaned binId (no matching bin) as ungrouped", () => {
    const forest = buildBinForest([m("a", "gone"), m("b", "b1")], [bin("b1")]);
    expect(ids(forest.roots[0].items)).toEqual(["b"]);
    expect(ids(forest.ungrouped)).toEqual(["a"]);
  });

  it("nests sub-bins under their parent to arbitrary depth", () => {
    const bins = [bin("root"), bin("child", "root"), bin("grand", "child")];
    const media = [m("a", "root"), m("b", "child"), m("c", "grand"), m("d")];
    const forest = buildBinForest(media, bins);
    expect(forest.roots).toHaveLength(1);
    const root = forest.roots[0];
    expect(root.bin.id).toBe("root");
    expect(ids(root.items)).toEqual(["a"]);
    expect(root.children).toHaveLength(1);
    const child = root.children[0];
    expect(child.bin.id).toBe("child");
    expect(ids(child.items)).toEqual(["b"]);
    expect(child.children[0].bin.id).toBe("grand");
    expect(ids(child.children[0].items)).toEqual(["c"]);
    expect(ids(forest.ungrouped)).toEqual(["d"]);
  });

  it("treats a bin whose parent is missing as top-level", () => {
    const forest = buildBinForest([], [bin("orphan", "ghost"), bin("normal")]);
    expect(binIds(forest.roots).sort()).toEqual(["normal", "orphan"]);
  });

  it("surfaces cycle members as roots instead of dropping them", () => {
    // a → b → a is a pure cycle: neither has a top-level ancestor.
    const forest = buildBinForest([], [bin("a", "b"), bin("b", "a")]);
    const seen = binIds(forest.roots);
    expect(seen).toContain("a");
    expect(seen).toContain("b");
    // No bin appears twice even though both reference each other.
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("treats a self-parenting bin as top-level", () => {
    const forest = buildBinForest([], [bin("loop", "loop")]);
    expect(binIds(forest.roots)).toEqual(["loop"]);
  });

  it("orders sub-bins with sortSiblings at every level, media untouched", () => {
    const bins = [bin("p"), bin("zsub", "p"), bin("asub", "p")];
    const media = [m("m2", "p"), m("m1", "p")];
    const byName = (level: Bin[]) => [...level].sort((x, y) => x.name.localeCompare(y.name));
    const forest = buildBinForest(media, bins, byName);
    expect(forest.roots[0].children.map((c) => c.bin.id)).toEqual(["asub", "zsub"]);
    expect(ids(forest.roots[0].items)).toEqual(["m2", "m1"]); // media order preserved
  });
});

describe("sortBins", () => {
  const t = (id: string, createdAt?: string) => bin(id, undefined, createdAt ? { createdAt } : {});
  it("sorts by name with numeric awareness, both directions", () => {
    const bins = [bin("B10"), bin("B2"), bin("A")];
    expect(sortBins(bins, "name", "asc").map((b) => b.id)).toEqual(["A", "B2", "B10"]);
    expect(sortBins(bins, "name", "desc").map((b) => b.id)).toEqual(["B10", "B2", "A"]);
  });

  it("sorts by createdAt for 'added', newest-first on desc", () => {
    const bins = [t("late", "2026-03-01T00:00:00Z"), t("early", "2026-01-01T00:00:00Z")];
    expect(sortBins(bins, "added", "asc").map((b) => b.id)).toEqual(["early", "late"]);
    expect(sortBins(bins, "added", "desc").map((b) => b.id)).toEqual(["late", "early"]);
  });

  it("falls back to array order for un-stamped bins (stable), and reverses on desc", () => {
    const bins = [t("first"), t("second"), t("third")];
    expect(sortBins(bins, "added", "asc").map((b) => b.id)).toEqual(["first", "second", "third"]);
    expect(sortBins(bins, "added", "desc").map((b) => b.id)).toEqual(["third", "second", "first"]);
  });

  it("does not mutate the input array", () => {
    const bins = [bin("b"), bin("a")];
    sortBins(bins, "name", "asc");
    expect(bins.map((b) => b.id)).toEqual(["b", "a"]);
  });
});

describe("collectSubtree", () => {
  const bins = [bin("root"), bin("c1", "root"), bin("c2", "root"), bin("g1", "c1"), bin("other")];
  it("includes the root and all descendants", () => {
    expect([...collectSubtree(bins, "root")].sort()).toEqual(["c1", "c2", "g1", "root"]);
  });
  it("includes a deeper subtree only", () => {
    expect([...collectSubtree(bins, "c1")].sort()).toEqual(["c1", "g1"]);
  });
  it("returns just the id for a leaf", () => {
    expect([...collectSubtree(bins, "other")]).toEqual(["other"]);
  });
  it("terminates on a cycle", () => {
    const cyclic = [bin("a", "b"), bin("b", "a")];
    expect([...collectSubtree(cyclic, "a")].sort()).toEqual(["a", "b"]);
  });
});

describe("isDescendant", () => {
  const bins = [bin("root"), bin("c1", "root"), bin("g1", "c1"), bin("other")];
  it("is true for the node itself", () => {
    expect(isDescendant(bins, "root", "root")).toBe(true);
  });
  it("is true for a nested descendant at any depth", () => {
    expect(isDescendant(bins, "root", "g1")).toBe(true);
    expect(isDescendant(bins, "c1", "g1")).toBe(true);
  });
  it("is false for an unrelated bin", () => {
    expect(isDescendant(bins, "root", "other")).toBe(false);
  });
  it("is false for an ancestor (not a descendant of its child)", () => {
    expect(isDescendant(bins, "g1", "root")).toBe(false);
  });
  it("terminates on a cycle", () => {
    const cyclic = [bin("a", "b"), bin("b", "a")];
    expect(isDescendant(cyclic, "a", "b")).toBe(true);
  });
});

describe("planItemMove", () => {
  it("moves a clip into a bin", () => {
    const plan = planItemMove([bin("b1")], [m("a")], ["a"], [], "b1");
    expect(plan.moveMediaIds).toEqual(["a"]);
    expect(plan.reparentBinIds).toEqual([]);
  });

  it("drops a no-op clip already in the target", () => {
    const plan = planItemMove([bin("b1")], [m("a", "b1")], ["a"], [], "b1");
    expect(plan.moveMediaIds).toEqual([]);
  });

  it("reparents a bin to the top level, dropping the no-op case", () => {
    const bins = [bin("root"), bin("c1", "root"), bin("c2")];
    expect(planItemMove(bins, [], [], ["c1"], null).reparentBinIds).toEqual(["c1"]);
    // c2 is already top-level → no-op
    expect(planItemMove(bins, [], [], ["c2"], null).reparentBinIds).toEqual([]);
  });

  it("moves only the top of a selected branch (descendants travel inside it)", () => {
    const bins = [bin("p"), bin("c", "p"), bin("g", "c"), bin("dest")];
    // Selecting p, c and g together and moving to dest → only p reparents.
    const plan = planItemMove(bins, [], [], ["p", "c", "g"], "dest");
    expect(plan.reparentBinIds).toEqual(["p"]);
  });

  it("leaves a clip inside a selected bin to travel with the bin", () => {
    const bins = [bin("b1"), bin("dest")];
    const media = [m("a", "b1")];
    // Move bin b1 AND its clip a to dest → only b1 reparents; a stays in b1.
    const plan = planItemMove(bins, media, ["a"], ["b1"], "dest");
    expect(plan.reparentBinIds).toEqual(["b1"]);
    expect(plan.moveMediaIds).toEqual([]);
  });

  it("refuses to move a bin into its own subtree (cycle)", () => {
    const bins = [bin("a"), bin("b", "a")];
    expect(planItemMove(bins, [], [], ["a"], "b").reparentBinIds).toEqual([]);
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
