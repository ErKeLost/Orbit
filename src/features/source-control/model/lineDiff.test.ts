import { describe, expect, it } from "bun:test";
import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import { LINE_DIFF_CONFIG, lineDiff } from "./lineDiff";
import { buildUnifiedFile } from "./unifiedDiff";

/** A large file: many distinct lines, like real source. */
function bigFile(lines: number): string {
  return Array.from(
    { length: lines },
    (_, index) => `  const value${index} = compute(${index}, "${index * 7}");`,
  ).join("\n") + "\n";
}

/** Edits spread through the whole file, the case char-level diff gives up on. */
function scatterEdits(text: string): { next: string; changed: number } {
  let changed = 0;
  const next = text
    .split("\n")
    .map((line, index) => {
      if (index % 50 !== 10) return line;
      changed += 1;
      return `${line} // edited`;
    })
    .join("\n");
  return { next, changed };
}

describe("lineDiff", () => {
  it("maps line changes back to character offsets", () => {
    const a = "one\ntwo\nthree\n";
    const b = "one\nTWO\nthree\nfour\n";
    const changes = lineDiff(a, b).map((change) => ({
      a: a.slice(change.fromA, change.toA),
      b: b.slice(change.fromB, change.toB),
    }));
    expect(changes).toEqual([
      { a: "two\n", b: "TWO\n" },
      { a: "", b: "four\n" },
    ]);
  });

  it("treats a missing final newline as a change to the last line", () => {
    const changes = lineDiff("a\nb", "a\nb\n");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ fromA: 2, toA: 3, fromB: 2, toB: 4 });
  });

  it("stays precise on a large file with scattered edits", () => {
    const original = bigFile(12_000);
    const { next, changed } = scatterEdits(original);
    const chunks = Chunk.build(
      Text.of(original.split("\n")),
      Text.of(next.split("\n")),
      LINE_DIFF_CONFIG,
    );
    expect(chunks).toHaveLength(changed);
    expect(chunks.every((chunk) => chunk.precise)).toBe(true);
  });
});

describe("buildUnifiedFile on large files", () => {
  it("reports only the edited lines instead of replacing the file", () => {
    const original = bigFile(12_000);
    const { next, changed } = scatterEdits(original);
    const diff = buildUnifiedFile(original, next);
    expect(diff.additions).toBe(changed);
    expect(diff.deletions).toBe(changed);
  });

});
