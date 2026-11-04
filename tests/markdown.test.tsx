import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, preloadMath } from "../src/components/Markdown";

await preloadMath();

const FENCE = "```";

describe("shared Markdown renderer", () => {
  test("renders GFM tables and KaTeX through the shared markdown pipeline", () => {
    const html = renderToStaticMarkup(
      <Markdown content={"| Item | Value |\n| --- | --- |\n| math | $x^2$ |"} />,
    );

    expect(html).toContain("<table>");
    expect(html).toContain("md-table-scroll");
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

  test("streaming renders plain markdown without word-level smoothing", () => {
    const html = renderToStaticMarkup(<Markdown content="live trail" animated />);

    expect(html).toContain("is-streaming");
    expect(html).toContain('data-streaming=""');
    expect(html).not.toContain('class="stream-char"');
    expect(html).toContain("live trail");
  });

  test("renders GitHub alerts instead of a literal marker", () => {
    const html = renderToStaticMarkup(<Markdown content={"> [!WARNING]\n> careful"} />);

    expect(html).toContain("md-alert-warning");
    expect(html).not.toContain("[!WARNING]");
    expect(html).toContain("careful");
  });

  test("gives headings fragment ids and keeps the anchor in the page", () => {
    const html = renderToStaticMarkup(<Markdown content={"## Install\n\n[jump](#install)"} />);

    expect(html).toContain('id="user-content-install"');
    expect(html).toContain('href="#install"');
  });

  test("tags inline code so a file name can become a chip", () => {
    const html = renderToStaticMarkup(<Markdown content={"run `vite build` now"} />);

    expect(html).toContain("data-inline-code");
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

  test("diagram fences (dot/echarts/vega) keep source until the client upgrades them", () => {
    for (const fence of ["dot\ndigraph { a -> b }", "echarts\n{\"xAxis\":{\"type\":\"category\"}}", "vega-lite\n{\"mark\":\"bar\"}"]) {
      const html = renderToStaticMarkup(<Markdown content={FENCE + fence + "\n" + FENCE} />);
      expect(html).toContain("markdown-diagram-shell");
      expect(html).toContain("<pre>");
    }
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
