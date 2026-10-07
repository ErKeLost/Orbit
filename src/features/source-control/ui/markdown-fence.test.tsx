import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../../../components/Markdown";

const FENCE = "```";

/**
 * 语言标签缺失的代码围栏走 CodeFrame 的纯文本分支：头部（图标/纯文本/复制）
 * + `<pre><code>` 一体。回归点：
 *  - 内容只渲染一次，且在 .markdown-code-shell 框内（曾出现过内容落到框外的报告）；
 *  - `<pre>` 带 stream-block 类（Streamdown 的透明度动画目标），保证
 *    monocode.css 里 `.markdown-static .stream-block` 的可见性覆盖命得中。
 */
test("language-less fence keeps content inside the frame, exactly once", () => {
  const html = renderToStaticMarkup(
    <Markdown content={"before\n\n" + FENCE + "\n[pi-gui] [ x 3 ]  +1 -2\n" + FENCE + "\n\nafter"} />,
  );
  const shellStart = html.indexOf("markdown-code-shell");
  expect(shellStart).toBeGreaterThan(-1);
  const codeIndex = html.indexOf("[pi-gui]");
  expect(codeIndex).toBeGreaterThan(shellStart);
  expect(html.split("[pi-gui]").length - 1).toBe(1);
  const preIndex = html.indexOf("<pre", shellStart);
  expect(preIndex).toBeGreaterThan(shellStart);
  expect(html.slice(preIndex, preIndex + 60)).toContain("stream-block");
});
