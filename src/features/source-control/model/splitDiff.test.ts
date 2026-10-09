import { describe, expect, it } from "bun:test";
import { buildUnifiedFile } from "./unifiedDiff";
import {
  flattenVisibleRows,
  type DiffViewRow,
} from "./unifiedDiffWindow";
import { splitColumnWidth, toSplitRows, type SplitRow } from "./splitDiff";

function splitOf(original: string, current: string, canStageHunk = false): SplitRow[] {
  const diff = buildUnifiedFile(original, current);
  return toSplitRows(
    flattenVisibleRows(diff.blocks, () => undefined, canStageHunk),
  );
}

describe("split diff rows", () => {
  it("pairs a deletion with its insertion on one row", () => {
    const rows = splitOf("alpha\nbeta\ngamma\n", "alpha\nBETA\ngamma\n");
    expect(rows.map((row) => row.type)).toEqual(["pair", "pair", "pair"]);
    const changed = rows[1];
    if (changed?.type !== "pair") throw new Error("expected a pair");
    expect(changed.left.kind).toBe("del");
    expect(changed.left.kind !== "void" && changed.left.line.text).toBe("beta");
    expect(changed.right.kind).toBe("add");
    expect(changed.right.kind !== "void" && changed.right.line.text).toBe("BETA");
  });

  it("fills the old column with voids when lines are only added", () => {
    const rows = splitOf("alpha\n", "alpha\none\ntwo\n");
    expect(rows.map((row) => row.type)).toEqual(["pair", "pair", "pair"]);
    expect(rows[1]?.type === "pair" && rows[1].left.kind).toBe("void");
    expect(rows[1]?.type === "pair" && rows[1].right.kind).toBe("add");
    expect(rows[2]?.type === "pair" && rows[2].left.kind).toBe("void");
    expect(rows[2]?.type === "pair" && rows[2].right.kind).toBe("add");
  });

  it("fills the new column with voids when lines are only removed", () => {
    const rows = splitOf("alpha\none\ntwo\n", "alpha\n");
    expect(rows[1]?.type === "pair" && rows[1].left.kind).toBe("del");
    expect(rows[1]?.type === "pair" && rows[1].right.kind).toBe("void");
    expect(rows[2]?.type === "pair" && rows[2].left.kind).toBe("del");
    expect(rows[2]?.type === "pair" && rows[2].right.kind).toBe("void");
  });

  it("drops the @@ hunk headers the fold bars replace", () => {
    const original = Array.from({ length: 60 }, (_, i) => `old ${i}`).join("\n");
    const current = original.replace("old 30", "new 30");
    for (const row of splitOf(original, current)) {
      if (row.type !== "pair") continue;
      for (const cell of [row.left, row.right]) {
        if (cell.kind !== "void") expect(cell.line.text.startsWith("@@")).toBe(false);
      }
    }
  });

  it("keeps fold bars with their hidden counts", () => {
    const original = Array.from({ length: 60 }, (_, i) => `old ${i}`).join("\n");
    const current = original.replace("old 30", "new 30");
    const rows = splitOf(original, current);
    const folds = rows.filter((row) => row.type === "fold");
    expect(folds.length).toBeGreaterThan(0);
    for (const fold of folds) {
      if (fold.type !== "fold") continue;
      expect(fold.hidden).toBeGreaterThan(0);
      expect(fold.height).toBe(32);
    }
  });

  it("a context line closes a change run, and a trailing deletion gets a void", () => {
    // run 1: del a + add X pair; the context lines stand alone; the trailing
    // deletion has no insertion to meet, so it hatches the right column.
    const rows = splitOf("a\nb\nc\nd\n", "X\nb\nc\n");
    expect(rows[0]?.type === "pair" && rows[0].left.kind).toBe("del");
    expect(rows[0]?.type === "pair" && rows[0].right.kind).toBe("add");
    expect(rows[1]?.type === "pair" && rows[1].left.kind).toBe("context");
    expect(rows[2]?.type === "pair" && rows[2].left.kind).toBe("context");
    expect(rows[3]?.type === "pair" && rows[3].left.kind).toBe("del");
    expect(rows[3]?.type === "pair" && rows[3].right.kind).toBe("void");
  });

  it("carries the stage position of the hunk a changed row belongs to", () => {
    const rows = splitOf("alpha\nbeta\ngamma\n", "alpha\nBETA\ngamma\n", true);
    const changed = rows[1];
    expect(changed?.type === "pair" && changed.stage).toBe(true);
    expect(changed?.type === "pair" && typeof changed.stagePos).toBe("number");
  });

  it("widths to the longest line either column shows", () => {
    const rows = splitOf("short\n", "a much longer replacement line\n");
    expect(splitColumnWidth(rows)).toBe("a much longer replacement line".length);
  });
});
