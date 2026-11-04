/**
 * `\[ … \]` / `\( … \)` → `$$ … $$` / `$ … $`。
 *
 * remark-math 只认美元符号，而模型（尤其 Claude/Gemini）一半的公式用 LaTeX
 * 原生的括号定界符。Streamdown 时代这一步由它的 `preprocessLaTeX` 完成，
 * 换成 react-markdown 之后必须自己保留：围栏代码块和行内 code 里的反斜杠
 * 不能动，否则 `\(` 出现在示例代码里也会被当成公式。
 */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

function replaceOutsideCodeSpans(line: string): string {
  // 行内 code span 由等长反引号包裹；按它切开，奇偶交替保证只改正文。
  return line
    .split(/(`+[^`]*`+)/)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .replace(/\\\[/g, "$$")
            .replace(/\\\]/g, "$$")
            .replace(/\\\(/g, "$")
            .replace(/\\\)/g, "$"),
    )
    .join("");
}

export function normalizeLatexDelimiters(source: string): string {
  if (!source.includes("\\(") && !source.includes("\\[")) return source;

  const lines = source.split("\n");
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = FENCE.exec(line);
    if (match?.[1]) {
      const marker = match[1];
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    lines[index] = replaceOutsideCodeSpans(line);
  }
  return lines.join("\n");
}
