import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/components/Markdown";
import { deviconFromHref, externalLinkIcon } from "../src/lib/link-visual";

describe("shared Markdown renderer", () => {
  test("renders GFM tables and KaTeX through LobeHub Streamdown", () => {
    const html = renderToStaticMarkup(
      <Markdown content={"| Item | Value |\n| --- | --- |\n| math | $x^2$ |"} />,
    );

    expect(html).toContain("<table>");
    expect(html).toContain('class="katex"');
    expect(html).toContain("markdown-static");
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
    expect(html).toContain("md-code");
    expect(html).toContain("TypeScript");
    expect(html).toContain("aria-label=\"复制代码\"");
  });

  test("labels unlabeled fences as plain text with copy and download actions", () => {
    const html = renderToStaticMarkup(<Markdown content={"```\nhello\n```"} />);

    expect(html).toContain("md-code");
    expect(html).toContain("纯文本");
    expect(html).toContain("aria-label=\"下载代码\"");
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
    expect(html).toContain("md-autolink");
    expect(html).toContain("md-selectable-text");
    expect(html).not.toContain("node=\"[object Object]\"");
  });

  test("renders file autolinks with an icon and package mentions as chips", () => {
    const html = renderToStaticMarkup(
      <Markdown content={"Read https://lobehub.com/icons/skill.md and follow @lobehub/icons"} />,
    );

    expect(html).toContain("md-autolink");
    expect(html).toContain("href=\"https://lobehub.com/icons/skill.md\"");
    expect(html).toContain('data-link-icon="file:skill.md"');
    expect(html).toContain("md-chip is-mention");
  });

  test("renders bundled brand logos for external links", () => {
    const html = renderToStaticMarkup(<Markdown content="https://github.com/openai/codex" />);

    expect(html).toContain("md-autolink-icon");
    expect(html).toContain('data-link-icon="devicon:github"');
    expect(externalLinkIcon("https://github.com/openai/codex")).toBe("devicon:github");
    expect(deviconFromHref("https://github.com/openai/codex")).toBe("github");
  });

  test("keeps GitHub brand icons when the last path segment looks like a version", () => {
    const html = renderToStaticMarkup(
      <Markdown content="https://github.com/ErKeLost/pi-gui/releases/tag/v0.2.2" />,
    );

    expect(html).toContain('data-link-icon="devicon:github"');
    expect(html).not.toContain("data-link-icon=\"file:");
  });

  test("matches colored Devicon logos from the hostname", () => {
    const href = "https://vercel.com/docs/ai-gateway";
    const html = renderToStaticMarkup(<Markdown content={href} />);

    expect(deviconFromHref(href)).toBe("vercel");
    expect(html).toContain('data-link-icon="devicon:vercel"');
    expect(externalLinkIcon("https://youtube.com")).toBe("youtube-logo-fill");
  });
});
