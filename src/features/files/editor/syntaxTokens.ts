import type { ColorScheme } from "../../settings/model/appearance";
import type { UnifiedBlock, UnifiedLine } from "../../source-control/model/unifiedDiff";

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

/**
 * Per-language syntax coloring for the diff view. Orbit does not ship the
 * CodeMirror language pack, so tokens come back empty: rows render with the
 * same add/del backgrounds and plain text. A highlighter (e.g. shiki) can
 * slot in here later without touching the view.
 */
export function highlightDiffFile(
  file: DiffFile,
  scheme: ColorScheme,
): Promise<Map<UnifiedLine, SyntaxToken[]>> {
  void file;
  void scheme;
  return Promise.resolve(new Map());
}

export function highlightSource(
  text: string,
  _language: unknown,
  _scheme: ColorScheme,
): SyntaxToken[][] {
  if (!text) return [[]];
  return text.split("\n").map((line) => (line ? [{ text: line }] : []));
}
