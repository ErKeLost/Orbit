import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, preloadMath } from "../src/components/Markdown";

await preloadMath();

describe("shared Markdown renderer", () => {
  test("renders GFM tables and KaTeX through LobeHub Streamdown", () => {
    const html = renderToStaticMarkup(
      <Markdown content={"| Item | Value |\n| --- | --- |\n| math | $x^2$ |"} />,
    );

    expect(html).toContain("<table>");
    expect(html).toContain('class="katex"');
    expect(html).toContain("markdown-static");
    expect(html).toContain("agent-markdown");
  });

  test("normalizes bracket-style math before rendering", () => {
    const html = renderToStaticMarkup(<Markdown content={String.raw`\[x + y\]`} animated />);

    expect(html).toContain("x + y</annotation>");
    expect(html).not.toContain(String.raw`\[x + y\]`);
    expect(html).toContain("is-streaming");
  });

  test("wraps the live tail per character for the streaming color trail", () => {
    const html = renderToStaticMarkup(<Markdown content="trail" animated />);

    expect(html.match(/class="stream-char"/g)).toHaveLength(5);
    expect(html).toContain("animation-duration: 900ms");
  });

  test("renders fenced code as a pre block before Shiki upgrades it", () => {
    const html = renderToStaticMarkup(<Markdown content={"```ts\nconst reveal = (chars: string[]) => chars.map((char, i) => ({ char, delay: i * 18 }));\n```"} />);

    expect(html).toContain("<pre>");
    expect(html).toContain("const reveal");
    expect(html).toContain("markdown-code-shell");
    expect(html).toContain("TypeScript");
    expect(html).toContain("aria-label=\"复制代码\"");
  });

  test("labels unlabeled fences as plain text with a copy action", () => {
    const html = renderToStaticMarkup(<Markdown content={"```\nhello\n```"} />);

    expect(html).toContain("markdown-code-shell");
    expect(html).toContain("纯文本");
    expect(html).toContain("aria-label=\"复制代码\"");
    expect(html).toContain("hello");
  });

  // 图表库（几 MB）现在是动态加载的，服务端渲染只能给出升级前的纯代码形态；
  // 浏览器里图表块靠近视口后会在原处升级成 SVG。
  test("keeps mermaid fences as plain code until the diagram bundle loads", () => {
    const html = renderToStaticMarkup(
      <Markdown content={"```mermaid\nflowchart LR\n  A --> B\n```"} />,
    );

    expect(html).toContain("<pre>");
    expect(html).toContain("flowchart LR");
    expect(html).not.toContain("class=\"mermaid\"");
  });

  test("keeps mermaid fences as plain code while streaming", () => {
    const html = renderToStaticMarkup(
      <Markdown animated content={"```mermaid\nflowchart LR\n  A --> B\n```"} />,
    );

    expect(html).toContain("<pre>");
    expect(html).toContain("flowchart LR");
    expect(html).not.toContain("class=\"mermaid\"");
  });

  test("renders GFM task lists, strikethrough, quotes and autolinks", () => {
    const html = renderToStaticMarkup(
      <Markdown
        content={
          "- [x] Task list item\n\n~~strikethrough~~\n\n> quoted line\n\nhttps://streamdown.lobehub.com"
        }
      />,
    );

    expect(html).toContain("checkbox");
    expect(html).toContain("<del>");
    expect(html).toContain("<blockquote");
    expect(html).toContain("href=\"https://streamdown.lobehub.com\"");
    expect(html).toContain("target=\"_blank\"");
    expect(html).toContain("md-selectable-text");
    expect(html).not.toContain("node=\"[object Object]\"");
  });

  test("renders package mentions as chips", () => {
    const html = renderToStaticMarkup(<Markdown content={"follow @lobehub/icons"} />);
    expect(html).toContain("md-chip is-mention");
  });



});
