import { codeToHtml, codeToTokens } from "shiki";
import type { HighlightResult, HighlightToken } from "./types";

/**
 * 真正跑 shiki 的地方。这里不碰 DOM、不读 `document`，所以既能在 Worker 里跑，
 * 也能在测试里直接调（`tests/highlight.test.ts` 用它验证双主题产出）。
 */

/** 两套调色板一起进出：切主题只换 CSS 变量，不用重算。 */
export const HIGHLIGHT_THEMES = {
  light: "vitesse-light",
  dark: "vitesse-dark",
} as const;

/** 超过这个长度，一次 pass 的时间已经长过读者愿意等的程度。 */
export const MAX_HIGHLIGHT_CHARS = 400_000;

const DARK_STYLE_KEY = "--shiki-dark";

export async function highlightHtml(code: string, lang: string): Promise<string> {
  if (!code || code.length > MAX_HIGHLIGHT_CHARS) return "";
  return codeToHtml(code, { lang: lang as never, themes: HIGHLIGHT_THEMES });
}

/**
 * 逐行 token 形态，给 diff 用：diff 的每一行是自己画的 `<span>`，不是 shiki
 * 生成的 `<pre>`，所以只能要 token，不能要 HTML。
 */
export async function highlightLines(
  code: string,
  lang: string,
): Promise<HighlightToken[][]> {
  if (!code.trim() || code.length > MAX_HIGHLIGHT_CHARS) return [];
  const { tokens } = await codeToTokens(code, {
    lang: lang as never,
    themes: HIGHLIGHT_THEMES,
  });
  return tokens.map((line) =>
    line.map((token) => toToken(token.content, token.htmlStyle)),
  );
}

function toToken(text: string, style: unknown): HighlightToken {
  if (!style || typeof style !== "object") return { text };
  const record = style as Record<string, string | undefined>;
  const color = record.color;
  const darkColor = record[DARK_STYLE_KEY];
  return {
    text,
    ...(color ? { color } : {}),
    ...(darkColor ? { darkColor } : {}),
  };
}

export function runHighlight(
  kind: HighlightResult["kind"],
  code: string,
  lang: string,
): Promise<HighlightResult> {
  return kind === "html"
    ? highlightHtml(code, lang).then((html) => ({ kind: "html", html }) as const)
    : highlightLines(code, lang).then((lines) => ({ kind: "lines", lines }) as const);
}
