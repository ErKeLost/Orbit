import { describe, expect, test } from "bun:test";
import { mdxToMarkdown } from "../src/shared/lib/mdxLite";

describe("mdxToMarkdown", () => {
  test("plain markdown passes through untouched", () => {
    const source = "# Title\n\n> quote with [link](https://example.com)\n\n- item\n";
    expect(mdxToMarkdown(source)).toBe(source);
  });

  test("strips MDX props from fence info so the language is recognized", () => {
    expect(mdxToMarkdown("```mermaid theme={null}\ngraph TD\n```")).toBe("```mermaid\ngraph TD\n```");
    expect(mdxToMarkdown('```bash title="run"\necho hi\n```')).toBe("```bash\necho hi\n```");
    expect(mdxToMarkdown("```tsx\nconst a = 1;\n```")).toBe("```tsx\nconst a = 1;\n```");
  });

  test("leaves code fence content untouched, including JSX examples", () => {
    const source = "```tsx\n<Routes>\n  <Tip>hello</Tip>\n</Routes>\n```";
    expect(mdxToMarkdown(source)).toBe(source);
  });

  test("folds a multi-line Tip into a blockquote, keeping markdown inside", () => {
    const source = "<Tip>\n  有关完整的文档，请访问[官方文档](https://example.com)。\n</Tip>";
    expect(mdxToMarkdown(source)).toBe("> 有关完整的文档，请访问[官方文档](https://example.com)。");
  });

  test("folds a single-line Tip and keeps blank lines inside the blockquote", () => {
    expect(mdxToMarkdown("<Tip>short note</Tip>")).toBe("> short note");
    expect(mdxToMarkdown("<Note>\nfirst\n\nsecond\n</Note>")).toBe("> first\n>\n> second");
  });

  test("unwraps Frame with a multi-line img into an image plus caption", () => {
    const source = [
      '<Frame caption="运行在 Claude 中的 Excalidraw MCP App">',
      '  <img src="https://mintcdn.com/x.gif?s=abc" alt="An Excalidraw MCP App" width="620" height="510" />',
      "</Frame>",
    ].join("\n");
    expect(mdxToMarkdown(source)).toBe(
      '![An Excalidraw MCP App](https://mintcdn.com/x.gif?s=abc)\n\n*运行在 Claude 中的 Excalidraw MCP App*',
    );
  });

  test("folds a bare img tag spanning multiple lines", () => {
    const source = '<img\n  src="https://example.com/a b.png"\n  alt="shot"\n/>';
    expect(mdxToMarkdown(source)).toBe("![shot](<https://example.com/a b.png>)");
  });

  test("unwraps container components, lifting title attributes", () => {
    expect(mdxToMarkdown('<Tabs>\n<Tab title="First">a</Tab>\n</Tabs>')).toBe("**First**\n\na");
    expect(mdxToMarkdown("<Steps>\n\n- one\n\n</Steps>")).toBe("- one");
    expect(mdxToMarkdown("<Routes>\nbody\n</Routes>")).toBe("body");
  });

  test("cleans inline HTML into markdown equivalents", () => {
    expect(mdxToMarkdown("press <kbd>Ctrl</kbd> and <b>hold</b>")).toBe("press `Ctrl` and **hold**");
    expect(mdxToMarkdown("line one<br/>line two")).toBe("line one\\\nline two");
    expect(mdxToMarkdown("<span style={{ color: 'red' }}>red</span>")).toBe("red");
  });

  test("drops ESM imports and falls back on malformed MDX", () => {
    expect(mdxToMarkdown('import Frame from "x"\n\n# hello')).toBe("# hello");
    // remark-mdx 对非法 JSX 是硬错误：回退原文，渲染器按字面显示（旧行为）。
    expect(mdxToMarkdown("<Tip>unclosed")).toBe("<Tip>unclosed");
  });

  test("survives a Mintlify document end to end", () => {
    const source = [
      "# MCP Apps",
      "",
      "> subtitle",
      "",
      "<Tip>",
      "  请访问[官方文档](https://apps.example.com)。",
      "</Tip>",
      "",
      '<Frame caption="caption text">',
      '  <img src="https://mintcdn.com/mcp/x.gif?s=c783" alt="demo" width="620" />',
      "</Frame>",
      "",
      "```mermaid theme={null}",
      "sequenceDiagram",
      "    User->>Agent: hi",
      "```",
    ].join("\n");
    const result = mdxToMarkdown(source);
    expect(result).toContain("> 请访问[官方文档](https://apps.example.com)。");
    expect(result).toContain("![demo](https://mintcdn.com/mcp/x.gif?s=c783)");
    expect(result).toContain("*caption text*");
    expect(result).toContain("```mermaid\nsequenceDiagram");
    expect(result).not.toContain("<Tip>");
    expect(result).not.toContain("<Frame");
    expect(result).not.toContain("theme={null}");
  });
});
