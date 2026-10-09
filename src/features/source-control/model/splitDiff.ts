import type { UnifiedLine } from "./unifiedDiff";
import {
  UNIFIED_FOLD_PX,
  UNIFIED_LINE_PX,
  type DiffViewRow,
} from "./unifiedDiffWindow";

/**
 * One half of a split diff row: a real line, or the placeholder that fills the
 * column opposite a change — the cell Codex paints as diagonal hatching.
 */
export type SplitCell =
  | { kind: "del" | "add" | "context"; line: UnifiedLine }
  | { kind: "void" };

export type SplitRow =
  | {
      type: "pair";
      left: SplitCell;
      right: SplitCell;
      /** The hunk this row belongs to can be staged (hover affordance). */
      stage: boolean;
      stagePos?: number;
      height: number;
    }
  | { type: "fold"; id: string; hidden: number; height: number };

type LineRow = Extract<DiffViewRow, { type: "line" }>;

/**
 * Turn the flat unified rows into side-by-side pairs.
 *
 * Within one change run the k-th deletion pairs with the k-th insertion —
 * the order the unified stream already carries — and whichever side runs out
 * first gets a void cell. Context lines end a run (they exist on both sides),
 * fold bars pass through untouched, and the `@@` hunk headers disappear: the
 * fold bars already carry the structure, and Codex-style diffs read cleaner
 * without them.
 */
export function toSplitRows(rows: readonly DiffViewRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let dels: LineRow[] = [];
  let adds: LineRow[] = [];

  const flush = () => {
    const count = Math.max(dels.length, adds.length);
    for (let index = 0; index < count; index += 1) {
      const left: SplitCell = dels[index]
        ? { kind: "del", line: dels[index].line }
        : { kind: "void" };
      const right: SplitCell = adds[index]
        ? { kind: "add", line: adds[index].line }
        : { kind: "void" };
      const staged = Boolean(dels[index]?.stage || adds[index]?.stage);
      const stagePos = adds[index]?.line.pos ?? dels[index]?.line.pos;
      out.push({
        type: "pair",
        left,
        right,
        stage: staged,
        stagePos: staged && stagePos != null ? stagePos : undefined,
        height: UNIFIED_LINE_PX,
      });
    }
    dels = [];
    adds = [];
  };

  for (const row of rows) {
    if (row.type === "fold") {
      flush();
      out.push({
        type: "fold",
        id: row.id,
        hidden: row.hidden,
        height: UNIFIED_FOLD_PX,
      });
      continue;
    }
    if (row.line.kind === "hunk") {
      flush();
      continue;
    }
    if (row.line.kind === "context") {
      flush();
      out.push({
        type: "pair",
        left: { kind: "context", line: row.line },
        right: { kind: "context", line: row.line },
        stage: false,
        height: UNIFIED_LINE_PX,
      });
      continue;
    }
    if (row.line.kind === "del") dels.push(row);
    else adds.push(row);
  }
  flush();
  return out;
}

/**
 * The longest line either column has to show. Both halves size to
 * `splitColumnWidth * 2` total, so the columns stay aligned while the whole
 * grid scrolls horizontally together.
 */
export function splitColumnWidth(rows: readonly SplitRow[]): number {
  let max = 20;
  for (const row of rows) {
    if (row.type !== "pair") continue;
    for (const cell of [row.left, row.right]) {
      if (cell.kind !== "void") max = Math.max(max, cell.line.text.length);
    }
  }
  return max;
}
