import type { UnifiedBlock, UnifiedLine } from "../../source-control/model/unifiedDiff";
import { languageForFileName } from "../../../components/FileHighlighter";
import { highlightToLines, type HighlightToken } from "../../../lib/highlight";

type DiffFile = {
  path: string;
  binary?: boolean;
  tooLarge?: boolean;
  blocks: readonly UnifiedBlock[];
};

/** 一段被上色的 diff 文字。`darkColor` 是 `--shiki-dark`，由 CSS 决定何时生效。 */
export type SyntaxToken = HighlightToken;

const MAX_DIFF_HIGHLIGHT_CHARS = 250_000;

/** 结果按 diff 模型本身（blocks 身份）缓存，deep 相等的同一份差异只算一次。 */
const cache = new WeakMap<object, HighlightToken[][]>();

/** Reconstructs the "current side" (context + added lines) in order. */
function currentSideLines(file: DiffFile): UnifiedLine[] {
  const lines: UnifiedLine[] = [];
  for (const block of file.blocks) {
    for (const line of block.lines) {
      if (line.kind !== "del") lines.push(line);
    }
  }
  return lines;
}

/**
 * 整个「当前侧」拼成一段连续源码再交给 shiki —— 只有连续文本才有正确的语法
 * 状态（字符串、注释、模板字面量跨行）。tokenize 在 Worker 里做，两个调色板
 * 一次产出，所以切明暗主题不再重新计算（旧实现按 scheme 分别缓存、切换即重跑）。
 */
export async function highlightDiffFile(
  file: DiffFile,
): Promise<Map<UnifiedLine, SyntaxToken[]>> {
  const empty = new Map<UnifiedLine, SyntaxToken[]>();
  if (file.binary || file.tooLarge || file.blocks.length === 0) return empty;

  const lines = currentSideLines(file);
  if (lines.length === 0) return empty;
  const text = lines.map((line) => line.text).join("\n");
  if (!text.trim() || text.length > MAX_DIFF_HIGHLIGHT_CHARS) return empty;

  const tokenized =
    cache.get(file.blocks) ??
    (await highlightToLines(text, languageForFileName(file.path)));
  if (!tokenized) return empty;
  if (!cache.has(file.blocks)) cache.set(file.blocks, tokenized);

  const result = new Map<UnifiedLine, SyntaxToken[]>();
  const count = Math.min(tokenized.length, lines.length);
  for (let index = 0; index < count; index += 1) {
    const lineTokens = tokenized[index];
    if (!lineTokens?.length) continue;
    result.set(lines[index], lineTokens);
  }
  return result;
}

/** Plain-text passthrough kept for callers outside the diff view. */
export function highlightSource(text: string): SyntaxToken[][] {
  if (!text) return [[]];
  return text.split("\n").map((line) => (line ? [{ text: line }] : []));
}
