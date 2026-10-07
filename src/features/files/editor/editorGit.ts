import { Chunk, type DiffConfig } from "@codemirror/merge";
import { Text } from "@codemirror/state";

/**
 * Stage-chunk support for the working-tree diff (MonoCode files/editor/editorGit).
 * Only the pure, editor-independent part is kept: `stageChunkText` and the
 * chunk-range helpers it needs.
 */

export const DIFF_CONFIG = { scanLimit: 5_000, timeout: 100 };

export type GitTextRange = { from: number; to: number };

type ChunkRange = {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
};

function textFromString(value: string): Text {
  return Text.of(value.split("\n"));
}

export function stageChunkText(
  original: string,
  current: string,
  pos: number,
  selection?: GitTextRange | null,
  /** Must match the config that produced `pos`, so the same hunk is found. */
  diffConfig: DiffConfig = DIFF_CONFIG,
): string | null {
  const orig = textFromString(original);
  const doc = textFromString(current);
  const changes = stageChunkChanges(
    orig,
    doc,
    pos,
    selection,
    "\n",
    diffConfig,
  );
  if (!changes) return null;
  return orig.replace(changes.from, changes.to, changes.insert).toString();
}

export function findChunk(
  doc: Text,
  chunks: readonly Chunk[],
  pos: number,
): Chunk | undefined {
  const at = Math.max(0, Math.min(pos, doc.length));
  const covering = chunks.find(
    (chunk) => chunk.fromB <= at && chunk.endB >= at,
  );
  if (covering) return covering;
  if (doc.length === 0) return chunks[0];
  const line = doc.lineAt(at);
  return chunks.find((chunk) => {
    if (chunk.fromB !== chunk.toB) return false;
    return chunk.fromB >= line.from && chunk.fromB <= line.to + 1;
  });
}

function chunksFor(
  original: Text | null,
  current: Text,
  diffConfig: DiffConfig = DIFF_CONFIG,
): readonly Chunk[] {
  if (!original) return [];
  return Chunk.build(original, current, diffConfig);
}

function stageChunkChanges(
  original: Text,
  doc: Text,
  pos: number,
  selection: GitTextRange | null | undefined,
  lineBreak: string,
  diffConfig?: DiffConfig,
): { from: number; to: number; insert: Text } | null {
  const range = actionChunkRange(original, doc, pos, selection, diffConfig);
  if (!range) return null;
  return applySide(
    doc,
    original,
    range.fromB,
    range.toB,
    range.fromA,
    range.toA,
    lineBreak,
  );
}

function applySide(
  source: Text,
  target: Text,
  fromS: number,
  toS: number,
  fromT: number,
  toT: number,
  lineBreak: string,
): { from: number; to: number; insert: Text } {
  let insert = source.sliceString(fromS, Math.max(fromS, toS - 1));
  if (fromS !== toS && toT <= target.length) {
    insert += lineBreak;
  }
  return {
    from: fromT,
    to: Math.min(target.length, toT),
    insert: textFromString(insert),
  };
}

function actionChunkRange(
  original: Text,
  doc: Text,
  pos: number,
  selection: GitTextRange | null | undefined,
  diffConfig?: DiffConfig,
): ChunkRange | null {
  const chunk = findChunk(doc, chunksFor(original, doc, diffConfig), pos);
  if (!chunk) return null;
  return narrowChunk(original, doc, chunk, selection);
}

function narrowChunk(
  original: Text,
  doc: Text,
  chunk: Chunk,
  selection: GitTextRange | null | undefined,
): ChunkRange {
  const whole = {
    fromA: chunk.fromA,
    toA: chunk.toA,
    fromB: chunk.fromB,
    toB: chunk.toB,
  };
  const selected = selectedLines(doc, selection);
  const hunkB = hunkLines(doc, chunk.fromB, chunk.toB, chunk.endB);
  if (!selected || !hunkB) return whole;

  const fromLine = Math.max(selected.fromLine, hunkB.fromLine);
  const toLine = Math.min(selected.toLine, hunkB.toLine);
  if (fromLine > toLine) return whole;
  if (fromLine === hunkB.fromLine && toLine === hunkB.toLine) return whole;

  const nextB = offsetsForLines(doc, fromLine, toLine);
  const hunkA = hunkLines(original, chunk.fromA, chunk.toA, chunk.endA);
  if (!hunkA) {
    return {
      fromA: chunk.fromA,
      toA: chunk.toA,
      fromB: nextB.from,
      toB: nextB.to,
    };
  }

  const aCount = hunkA.toLine - hunkA.fromLine + 1;
  const bCount = hunkB.toLine - hunkB.fromLine + 1;
  if (aCount === bCount) {
    const delta = fromLine - hunkB.fromLine;
    const length = toLine - fromLine;
    const aFromLine = hunkA.fromLine + delta;
    const aToLine = aFromLine + length;
    const nextA = offsetsForLines(original, aFromLine, aToLine);
    return {
      fromA: nextA.from,
      toA: nextA.to,
      fromB: nextB.from,
      toB: nextB.to,
    };
  }

  return {
    fromA: chunk.fromA,
    toA: chunk.toA,
    fromB: nextB.from,
    toB: nextB.to,
  };
}

function selectedLines(
  doc: Text,
  range: GitTextRange | null | undefined,
): { fromLine: number; toLine: number } | null {
  if (!range || range.from === range.to) return null;
  const from = Math.min(range.from, range.to);
  const to = Math.max(range.from, range.to);
  const start = doc.lineAt(Math.min(from, doc.length)).number;
  let end = doc.lineAt(Math.min(to, doc.length)).number;
  if (to > from && doc.lineAt(Math.min(to, doc.length)).from === to) {
    end = Math.max(start, end - 1);
  }
  return { fromLine: start, toLine: end };
}

function hunkLines(
  doc: Text,
  from: number,
  to: number,
  end: number,
): { fromLine: number; toLine: number } | null {
  if (from === to) return null;
  if (doc.length === 0) return { fromLine: 1, toLine: 1 };
  const start = Math.min(from, doc.length);
  const last = Math.max(start, Math.min(end, doc.length) - 1);
  return {
    fromLine: doc.lineAt(start).number,
    toLine: doc.lineAt(last).number,
  };
}

function offsetsForLines(
  doc: Text,
  fromLine: number,
  toLine: number,
): { from: number; to: number } {
  const from = doc.line(fromLine).from;
  const last = doc.line(toLine);
  return { from, to: last.to + 1 };
}
