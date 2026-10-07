import type { ColorScheme } from "../../settings/model/appearance";
import type { UnifiedBlock, UnifiedLine } from "../../source-control/model/unifiedDiff";
import { languageForFileName } from "../../../components/FileHighlighter";

type DiffFile = {
  path: string;
  binary?: boolean;
  tooLarge?: boolean;
  blocks: readonly UnifiedBlock[];
};

export type SyntaxToken = {
  text: string;
  color?: string;
};

/** Same bundle the chat code blocks and file preview already ship. */
type ShikiModule = typeof import("shiki");
let shikiPromise: Promise<ShikiModule> | null = null;
function loadShiki(): Promise<ShikiModule> {
  shikiPromise ??= import("shiki");
  return shikiPromise;
}

const MAX_DIFF_HIGHLIGHT_CHARS = 250_000;

/** Result cache keyed by the diff model itself (blocks identity), per scheme. */
const cache = new WeakMap<object, Map<ColorScheme, Map<UnifiedLine, SyntaxToken[]>>>();

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
 * Syntax tokens for every line of the working-tree/commit diff, straight from
 * shiki (the same engine the chat code blocks use). Falls back to no tokens on
 * unsupported languages or oversized diffs — rows render plain text then.
 */
export async function highlightDiffFile(
  file: DiffFile,
  scheme: ColorScheme,
): Promise<Map<UnifiedLine, SyntaxToken[]>> {
  const empty = new Map<UnifiedLine, SyntaxToken[]>();
  if (file.binary || file.tooLarge || file.blocks.length === 0) return empty;

  const perScheme = cache.get(file.blocks);
  const hit = perScheme?.get(scheme);
  if (hit) return hit;

  const lines = currentSideLines(file);
  const fullText = lines.map((line) => line.text).join("\n");
  if (!fullText.trim() || fullText.length > MAX_DIFF_HIGHLIGHT_CHARS) return empty;

  const result = new Map<UnifiedLine, SyntaxToken[]>();
  try {
    const { codeToTokens } = await loadShiki();
    const theme = scheme === "light" ? "vitesse-light" : "vitesse-dark";
    const { tokens } = await codeToTokens(fullText, {
      lang: languageForFileName(file.path) as never,
      theme,
    });
    const count = Math.min(tokens.length, lines.length);
    for (let index = 0; index < count; index += 1) {
      const lineTokens = tokens[index];
      if (!lineTokens?.length) continue;
      result.set(
        lines[index],
        lineTokens.map((token) => ({
          text: token.content,
          ...(token.color ? { color: token.color } : {}),
        })),
      );
    }
  } catch {
    return empty;
  }

  cache.set(file.blocks, (perScheme ?? new Map()).set(scheme, result));
  return result;
}

/** Plain-text passthrough kept for callers outside the diff view. */
export function highlightSource(text: string, _language: unknown, _scheme: ColorScheme): SyntaxToken[][] {
  if (!text) return [[]];
  return text.split("\n").map((line) => (line ? [{ text: line }] : []));
}
