/**
 * 聊天 markdown 的统一管线。移植自 t3code
 * `packages/shared/src/markdownPipeline.ts`（见 t3code/ submodule）。
 *
 * 这一层的职责只有三件：把 agent 实际会写的东西补成 markdown（GitHub
 * alerts、被误判成缩进代码的列表续行、图片独占一行），把围栏语言和 meta
 * 带到渲染层，以及给行内 code 打标记让上层能换成文件 chip。之后统一过
 * `rehype-raw` + `rehype-sanitize`，白名单之外的原生 HTML 一律不放行。
 *
 * 所有使用方（聊天、文件预览、inbox、artifact）都从这里拿插件列表，避免
 * 某个页面自己拼一套插件、渲染结果和聊天对不上。
 */
import type { Paragraph, PhrasingContent, Root, RootContent } from "mdast";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";

interface MarkdownAstNode {
  type?: string;
  value?: unknown;
  meta?: unknown;
  tagName?: string;
  properties?: Record<string, unknown>;
  data?: {
    hProperties?: Record<string, unknown>;
  };
  position?: {
    start?: { line?: number; offset?: number };
    end?: { line?: number; offset?: number };
  };
  children?: MarkdownAstNode[];
}

/* ------------------------------------------------------------------ *
 * GitHub alerts：`> [!NOTE]` 之类。t3code 的渲染层按 dataAlert 画出
 * 带图标和标题的块，否则 GitHub README 里的提示会退化成一堆字面量。
 * ------------------------------------------------------------------ */

const GITHUB_ALERT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/i;

function readGithubAlert(node: MarkdownAstNode): void {
  if (node.type !== "blockquote") return;
  const paragraph = node.children?.[0];
  const text = paragraph?.children?.[0];
  if (paragraph?.type !== "paragraph" || text?.type !== "text" || typeof text.value !== "string") {
    return;
  }
  const match = GITHUB_ALERT_MARKER.exec(text.value);
  if (!match?.[1]) return;

  const remainder = text.value.slice(match[0].length);
  // 标记自身那一行是否在这个 text 节点里结束。没有它的话，空 remainder 是有歧义的：
  // `[!NOTE]\n**bold**` 会解析成 [text "[!NOTE]\n", strong]，下一行的内容在兄弟节点里；
  // 而 `[!NOTE]*aside*` 除换行之外解析结果一样。
  const markerEndsItsLine = match[0].endsWith("\n");
  if (remainder.length > 0) {
    text.value = remainder;
  } else if (markerEndsItsLine || paragraph.children?.length === 1) {
    paragraph.children?.shift();
    if (paragraph.children?.length === 0) {
      node.children?.shift();
    }
  } else {
    return;
  }

  node.data = {
    ...node.data,
    hProperties: {
      ...node.data?.hProperties,
      dataAlert: match[1].toLowerCase(),
    },
  };
}

export function remarkGithubAlerts() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      node.children?.forEach(visit);
      readGithubAlert(node);
    };
    visit(tree);
  };
}

/* ------------------------------------------------------------------ *
 * 列表续行。CommonMark 把列表标记之后四个以上空格当成缩进代码块，于是
 * agent 写的一行随手续行会变成一坨等宽代码。这里把这种节点按行内内容
 * 重新解析回来。
 * ------------------------------------------------------------------ */

interface MarkdownFile {
  readonly value?: unknown;
}

interface MarkdownParser {
  parse(markdown: string): unknown;
}

interface RecoveredMarkdown {
  readonly blocks: MarkdownAstNode[];
  readonly source: string;
}

const INLINE_PARSE_PREFIX = "orbit-markdown-inline-prefix:";

function isSameLineOverIndentedCode(
  node: MarkdownAstNode,
  parent: MarkdownAstNode | undefined,
  markdown: string,
): boolean {
  if (
    node.type !== "code" ||
    parent?.type !== "listItem" ||
    typeof node.value !== "string" ||
    !/^[\t ]/.test(node.value)
  ) {
    return false;
  }

  const nodeStart = node.position?.start;
  const parentStart = parent.position?.start;
  if (
    nodeStart?.line === undefined ||
    nodeStart.offset === undefined ||
    parentStart?.line === undefined ||
    nodeStart.line !== parentStart.line
  ) {
    return false;
  }

  const sourceCharacter = markdown[nodeStart.offset];
  return sourceCharacter !== "`" && sourceCharacter !== "~";
}

function parseRecoveredMarkdown(value: string, parser: MarkdownParser): RecoveredMarkdown {
  // 文本前缀把像块的输入按行内文本解析，同时保留 processor 上配置的行内
  // 扩展（例如 GFM）。后面的根级子节点仍然作为块保留，所以空行分隔的内容
  // 不会被丢掉。
  const source = `${INLINE_PARSE_PREFIX}${value}`;
  const document = parser.parse(source) as MarkdownAstNode;
  const blocks = document.children;
  const paragraph = blocks?.[0];
  const children = paragraph?.type === "paragraph" ? paragraph.children : undefined;
  const first = children?.[0];
  if (
    !blocks ||
    !children ||
    first?.type !== "text" ||
    typeof first.value !== "string" ||
    !first.value.startsWith(INLINE_PARSE_PREFIX)
  ) {
    return { blocks: [{ type: "text", value }], source };
  }

  const firstValue = first.value.slice(INLINE_PARSE_PREFIX.length);
  return {
    blocks: [
      {
        ...paragraph,
        type: "paragraph",
        children: [...(firstValue ? [{ ...first, value: firstValue }] : []), ...children.slice(1)],
      },
      ...blocks.slice(1),
    ],
    source,
  };
}

function blocksFromIndentedCode(node: MarkdownAstNode, parser: MarkdownParser): RecoveredMarkdown {
  const value = typeof node.value === "string" ? node.value.trim() : "";
  const recovered = parseRecoveredMarkdown(value, parser);
  const first = recovered.blocks[0];
  return {
    ...recovered,
    blocks:
      first && node.position
        ? [{ ...first, position: node.position }, ...recovered.blocks.slice(1)]
        : recovered.blocks,
  };
}

export function remarkNormalizeListItemIndentation(this: MarkdownParser) {
  return (tree: MarkdownAstNode, file: MarkdownFile) => {
    if (typeof file.value !== "string") {
      return;
    }
    const markdown = file.value;

    const visit = (node: MarkdownAstNode, source: string) => {
      if (!node.children) {
        return;
      }
      node.children = node.children.flatMap((child) => {
        if (isSameLineOverIndentedCode(child, node, source)) {
          const recovered = blocksFromIndentedCode(child, this);
          for (const block of recovered.blocks) {
            visit(block, recovered.source);
          }
          return recovered.blocks;
        }
        visit(child, source);
        return [child];
      });
    };

    visit(tree, markdown);
  };
}

/* ------------------------------------------------------------------ *
 * 图片独占一行。agent 习惯在截图上面写一行 `**Palette**` 当标签，CommonMark
 * 会把两行并成一个段落，图片就挤在标签右边。图片单独占源文件一行时保留这一行，
 * 行内徽章和正文仍然照常折行。
 * ------------------------------------------------------------------ */

const isImageNode = (node: PhrasingContent | undefined): boolean =>
  node?.type === "image" ||
  node?.type === "imageReference" ||
  ((node?.type === "link" || node?.type === "linkReference") &&
    node.children.length === 1 &&
    isImageNode(node.children[0]));

const endsLine = (node: PhrasingContent | undefined) =>
  node === undefined ||
  node.type === "break" ||
  (node.type === "text" && /\n[ \t]*$/.test(node.value));

const startsLine = (node: PhrasingContent | undefined) =>
  node === undefined ||
  node.type === "break" ||
  (node.type === "text" && /^[ \t]*\n/.test(node.value));

function breakLinesAroundImages(paragraph: Paragraph) {
  const children = paragraph.children;
  const ownsLine = (index: number) =>
    isImageNode(children[index]) &&
    endsLine(children[index - 1]) &&
    startsLine(children[index + 1]);
  paragraph.children = children.flatMap((child, index): PhrasingContent[] => {
    if (child.type !== "text") return [child];
    const afterImage = ownsLine(index - 1);
    const beforeImage = ownsLine(index + 1);
    if (!afterImage && !beforeImage) return [child];
    const parts: PhrasingContent[] = [];
    let value = child.value;
    if (afterImage) {
      value = value.replace(/^[ \t]*\n/, "");
      parts.push({ type: "break" });
    }
    const breakAfter = beforeImage && /\n[ \t]*$/.test(value);
    if (breakAfter) value = value.replace(/[ \t]*\n[ \t]*$/, "");
    if (value) parts.push({ type: "text", value });
    if (breakAfter) parts.push({ type: "break" });
    return parts;
  });
}

export function remarkBreakAroundImageLines() {
  return (tree: Root) => {
    const visit = (node: Root | RootContent) => {
      if (node.type === "paragraph") breakLinesAroundImages(node);
      else if ("children" in node) node.children.forEach(visit);
    };
    visit(tree);
  };
}

/* ------------------------------------------------------------------ *
 * 围栏的 meta（```ts title="a.ts"）和行内 code 标记。前者让代码块能显示
 * 文件名，后者让 `src/lib/utils.ts` 这种行内 code 换成可点击的 path chip。
 * ------------------------------------------------------------------ */

export function remarkPreserveCodeMeta() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      if (node.type === "code" && typeof node.meta === "string" && node.meta.trim().length > 0) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataCodeMeta: node.meta.trim(),
          },
        };
      }
      node.children?.forEach(visit);
    };

    visit(tree);
  };
}

export function remarkTagInlineCode() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode, insideLink: boolean) => {
      if (node.type === "inlineCode" && !insideLink) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataInlineCode: "",
          },
        };
      }
      const childInsideLink = insideLink || node.type === "link" || node.type === "linkReference";
      node.children?.forEach((child) => visit(child, childInsideLink));
    };

    visit(tree, false);
  };
}

/* ------------------------------------------------------------------ *
 * rehype：独立图片标记 + 清洗白名单。
 * ------------------------------------------------------------------ */

const STANDALONE_IMAGE_BLOCKS = new Set(["p", "div", "li", "td", "th", "figure", "center", "blockquote"]);

function meaningfulHastChildren(node: MarkdownAstNode): MarkdownAstNode[] {
  return (node.children ?? []).filter(
    (child) => !(child.type === "text" && typeof child.value === "string" && child.value.trim() === ""),
  );
}

function soleImageDescendant(node: MarkdownAstNode): MarkdownAstNode | undefined {
  const children = meaningfulHastChildren(node);
  if (children.length !== 1) return undefined;
  const only = children[0];
  if (only?.type !== "element") return undefined;
  if (only.tagName === "img") return only;
  return only.tagName === "a" || only.tagName === "strong" || only.tagName === "em"
    ? soleImageDescendant(only)
    : undefined;
}

function markStandaloneImages(node: MarkdownAstNode) {
  if (node.type === "root" || (node.tagName && STANDALONE_IMAGE_BLOCKS.has(node.tagName))) {
    const image = soleImageDescendant(node);
    if (image) image.properties = { ...image.properties, dataStandalone: true };
  }
  node.children?.forEach((child) => {
    if (child.type === "element") markStandaloneImages(child);
  });
}

/** 把图片的 title 留在 data 属性上：标题是尺寸提示（`=360x`）时不该同时当 tooltip。 */
export function rehypeMarkImages() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      if (node.type === "element" && node.tagName === "img") {
        const title = node.properties?.title;
        if (typeof title === "string") {
          node.properties = { ...node.properties, dataMarkdownTitle: title, title: undefined };
        }
      }
      node.children?.forEach(visit);
    };

    visit(tree);
    markStandaloneImages(tree);
  };
}

const MD_SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    // Fence 语言类名 + remark-math 的两个类。
    code: [["className", /^language-./, "math-inline", "math-display"], "dataCodeMeta", "dataInlineCode"],
    blockquote: [...(defaultSchema.attributes?.blockquote ?? []), "dataAlert"],
    a: [...(defaultSchema.attributes?.a ?? []), "dataFootnoteRef", "dataFootnoteBackref"],
    img: [...(defaultSchema.attributes?.img ?? []), "dataMarkdownTitle", "dataStandalone"],
    span: [...(defaultSchema.attributes?.span ?? []), ["className", "md-chip", "is-mention"]],
    details: [...(defaultSchema.attributes?.details ?? []), "open"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file", "mention"],
    src: [...(defaultSchema.protocols?.src ?? []), "file"],
  },
} satisfies Parameters<typeof rehypeSanitize>[0];

export const MARKDOWN_REMARK_PLUGINS: PluggableList = [
  remarkGfm,
  remarkGithubAlerts,
  remarkNormalizeListItemIndentation,
  remarkBreakAroundImageLines,
  remarkPreserveCodeMeta,
  remarkTagInlineCode,
];

/** 单个换行也换行：聊天里 agent 的紧凑列表靠它保持原样。 */
export const MARKDOWN_REMARK_PLUGINS_WITH_BREAKS: PluggableList = [
  remarkGfm,
  remarkGithubAlerts,
  remarkNormalizeListItemIndentation,
  remarkBreakAroundImageLines,
  remarkBreaks,
  remarkPreserveCodeMeta,
  remarkTagInlineCode,
];

export const MARKDOWN_REHYPE_PLUGINS: PluggableList = [
  rehypeMarkImages,
  rehypeRaw,
  [rehypeSanitize, MD_SANITIZE_SCHEMA],
];
