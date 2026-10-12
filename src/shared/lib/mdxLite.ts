/**
 * Mintlify 风格 MDX → markdown 的折叠层。从 docs 站点（modelcontextprotocol.io、
 * developers.openai.com 等）存下来的笔记是 MDX：`<Tip>`、`<Frame>`、裸 `<img>`、
 * 带 `theme={null}` 的围栏都不是 markdown，Streamdown 遇到原生 HTML 一律按字面
 * 文本打印。
 *
 * 解析与序列化走 remark 生态（remark-mdx / remark-gfm / remark-stringify），
 * 这里只负责「组件 → markdown 节点」的映射——Mintlify 组件是私有的，生态里
 * 没有现成转换器，这层映射大约几十行。聊天输出不经过这里，仅文档预览使用。
 */

import type * as Mdast from "mdast";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";

/** 折叠成引用块（callout）的组件，Mintlify 的 Tip/Note/Warning 家族。 */
const CALLOUTS = new Set(["Tip", "Note", "Warning", "Caution", "Info", "Check", "Danger"]);

/** 行内标签 → mdast 节点的等价物；不在表内的剥壳留文本。 */
const TEXT_ELEMENTS: Record<string, (children: MdNode[]) => MdNode> = {
  b: strong,
  strong,
  i: emphasis,
  em: emphasis,
  code: inlineCode,
  kbd: inlineCode,
  br: () => ({ type: "break" }),
};

/** MDX 特征：任意 JSX 标签、`key={...}` / `key="..."` 属性（含围栏 meta）、或行首 ESM import/export。 */
const MDX_HINT = /<[A-Za-z/][^>]*>|\b\w+\s*=\s*(?:"[^"]*"|'[^']*'|\{)|^\s*(?:import|export)\s/m;

/** remark-mdx 解析出的 JSX 属性：字符串字面量，或 `{...}` 表达式（取不了就丢）。 */
type Attribute = { type: string; name: string; value?: string | { type: string; value?: string } };

/** 覆盖 mdast + MDX 节点的最小结构类型，避免拉一堆 @types 传递包。 */
type MdNode = {
  type: string;
  name?: string;
  value?: string;
  meta?: string | null;
  lang?: string | null;
  url?: string;
  alt?: string;
  attributes?: Attribute[];
  children?: MdNode[];
};

function strong(children: MdNode[]): MdNode {
  return { type: "strong", children };
}

function emphasis(children: MdNode[]): MdNode {
  return { type: "emphasis", children };
}

function inlineCode(children: MdNode[]): MdNode {
  return { type: "inlineCode", value: toText(children) };
}

function paragraph(children: MdNode[]): MdNode {
  return { type: "paragraph", children };
}

function toText(nodes: MdNode[]): string {
  return nodes.map((node) => (node.type === "break" ? " " : node.value ?? toText(node.children ?? []))).join("");
}

function attr(node: MdNode, name: string): string {
  const found = node.attributes?.find((attribute) => attribute.name === name)?.value;
  if (typeof found === "string") return found.trim();
  return "";
}

const processor = unified()
  .use(remarkParse)
  .use(remarkMdx)
  .use(remarkGfm)
  .use(remarkStringify, { bullet: "-" });

/** JSX 块级元素 → mdast 块级节点（可能一对多，也可能被整个剥掉）。 */
function convertFlow(node: MdNode): MdNode[] {
  const name = node.name ?? "";
  const children = convertAll(node.children ?? []);
  const title = attr(node, "title");

  if (name.toLowerCase() === "img") {
    return [paragraph([{ type: "image", url: attr(node, "src"), alt: attr(node, "alt") }])];
  }

  if (CALLOUTS.has(name)) {
    const quote: MdNode = { type: "blockquote", children: title ? [paragraph([strong([{ type: "text", value: title }])]), ...children] : children };
    return [quote];
  }

  if (name === "Frame") {
    const caption = attr(node, "caption");
    return caption ? [...children, paragraph([emphasis([{ type: "text", value: caption }])])] : children;
  }

  // 其余组件（Tab/Card/Steps/未知组件……）：剥壳留内容，title 摘成加粗段。
  return title ? [paragraph([strong([{ type: "text", value: title }])]), ...children] : children;
}

/** JSX 行内元素 → mdast phrasing 节点。 */
function convertText(node: MdNode): MdNode[] {
  const children = convertAll(node.children ?? []);
  const name = (node.name ?? "").toLowerCase();
  const convert = TEXT_ELEMENTS[name];
  if (convert) return [convert(children)];
  if (name === "img") {
    return [{ type: "image", url: attr(node, "src"), alt: attr(node, "alt") }];
  }
  const title = attr(node, "title");
  return title ? [strong([{ type: "text", value: title }]), { type: "text", value: " " }, ...children] : children;
}

function titleParagraph(title: string): MdNode {
  return paragraph([strong([{ type: "text", value: title }])]);
}

/**
 * 段落里孤立的行内 JSX：单行形态的 `<Tip>正文</Tip>`、`<Tab title="x">正文</Tab>`。
 * remark-mdx 只把跨行 JSX 判为块级，单行的落成段落里的 text element——这里把它们
 * 升格回块级语义（引用块 / title 拆段）；普通行内元素返回 null 留在段落里。
 */
function promoteTextElement(node: MdNode): MdNode[] | null {
  const name = node.name ?? "";
  const children = convertAll(node.children ?? []);
  const title = attr(node, "title");

  if (name.toLowerCase() === "img") {
    return [paragraph([{ type: "image", url: attr(node, "src"), alt: attr(node, "alt") }])];
  }
  if (CALLOUTS.has(name)) {
    const inner = title ? [titleParagraph(title), paragraph(children)] : [paragraph(children)];
    return [{ type: "blockquote", children: inner }];
  }
  if (name === "Frame") {
    const caption = attr(node, "caption");
    const content = caption ? [...children, emphasis([{ type: "text", value: caption }])] : children;
    return [paragraph(content)];
  }
  return title ? [titleParagraph(title), paragraph(children)] : null;
}

function convertAll(nodes: MdNode[]): MdNode[] {
  const out: MdNode[] = [];
  for (const node of nodes) {
    switch (node.type) {
      // ESM import/export 与 MDX 花括号表达式：预览里没有意义，直接丢。
      case "mdxjsEsm":
      case "mdxFlowExpression":
      case "mdxJsxTextExpression":
      case "mdxJsxFlowExpression":
        break;
      case "mdxJsxFlowElement":
        out.push(...convertFlow(node));
        break;
      case "mdxJsxTextElement":
        out.push(...convertText(node));
        break;
      case "paragraph": {
        // 单行 JSX 会被 remark-mdx 包在段落里，能升格的就升格。
        const only = node.children?.length === 1 ? node.children[0] : null;
        const promoted = only?.type === "mdxJsxTextElement" ? promoteTextElement(only) : null;
        out.push(...(promoted ?? [{ ...node, children: convertAll(node.children ?? []) }]));
        break;
      }
      case "code": {
        // ```mermaid theme={null}：lang 本来就对，meta 会被序列化拼回 info string，剥掉。
        const { meta, ...rest } = node;
        out.push(meta && /\b\w+\s*=/.test(meta) ? rest : node);
        break;
      }
      default:
        out.push(node.children ? { ...node, children: convertAll(node.children) } : node);
    }
  }
  return out;
}

/**
 * 把 MDX 组件折叠成 markdown。纯 markdown 原样通过（不进解析管道）；代码围栏里
 * 的内容（包括围栏里的 JSX 示例）一个字都不动。解析失败的坏 MDX 回退原文。
 */
export function mdxToMarkdown(source: string): string {
  if (!MDX_HINT.test(source)) return source;
  try {
    const parsed = processor.parse(source) as unknown as MdNode;
    const markdown = processor.stringify({ type: "root", children: convertAll(parsed.children ?? []) } as unknown as Mdast.Root);
    // 序列化恒以换行结尾：原文没有结尾换行时先去掉再返回。
    return source.endsWith("\n") ? markdown : markdown.replace(/\n+$/, "");
  } catch {
    // 坏 MDX（remark-mdx 对非法 JSX 是硬错误）：回退原文，渲染器按字面显示，和旧行为一致。
    return source;
  }
}
