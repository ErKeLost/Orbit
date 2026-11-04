/**
 * 流式 markdown 的增量解析。移植自 t3code `apps/web/src/markdown-incremental.ts`。
 *
 * 每来一个 token 就整篇重解析，长回答（尤其是长代码块）会一直占住主线程。
 * 这里把「已经闭合的顶级围栏 + 一个空行」当成解析边界：前半段只解析一次并
 * 缓存节点，之后的 token 只解析后缀，再按 offset/line 把缓存节点平移回去。
 *
 * 两个前提必须成立，否则退回整篇解析：
 *  - 定义（链接引用定义、脚注定义）是全文档可见的，前缀缓存会把它们切走；
 *  - 流式 CR 可能是 CRLF 的一半，BOM 会在后缀边界被新 parser 吃掉。
 */
import type { Root, RootContent } from "mdast";
import type { Parser as UnifiedParser, Plugin } from "unified";

type Parser = UnifiedParser<Root>;

interface ParsedPrefix {
  source: string;
  offset: number;
  line: number;
  children: RootContent[];
}

function hasDefinitions(node: Root | RootContent): boolean {
  return (
    node.type === "definition" ||
    node.type === "footnoteDefinition" ||
    ("children" in node && node.children.some((child) => hasDefinitions(child)))
  );
}

function shiftPositions(node: Root | RootContent, offset: number, lines: number): void {
  if (node.position) {
    for (const point of [node.position.start, node.position.end]) {
      if (point.offset !== undefined) point.offset += offset;
      point.line += lines;
    }
  }
  if ("children" in node) {
    for (const child of node.children) shiftPositions(child, offset, lines);
  }
}

function createIncrementalMarkdownParser(parse: Parser): Parser {
  let cached: ParsedPrefix | undefined;

  return (source, file) => {
    if (source.includes("\r") || source.includes("\uFEFF")) return parse(source, file);

    const prefix = cached && source.startsWith(cached.source) ? cached : undefined;
    let root: Root;
    if (prefix) {
      root = parse(source.slice(prefix.offset), file);
      if (hasDefinitions(root)) return parse(source, file);
      shiftPositions(root, prefix.offset, prefix.line - 1);
      if (root.position) root.position.start = { line: 1, column: 1, offset: 0 };
      // remark 插件会就地改树。缓存持有的是原始节点，每次渲染拿到的是副本，
      // 位置信息也一并复制。
      root.children.unshift(...structuredClone(prefix.children));
    } else {
      root = parse(source, file);
      if (hasDefinitions(root)) return root;
    }

    for (let index = root.children.length - 1; index >= 0; index--) {
      const node = root.children[index];
      if (node?.type !== "code") continue;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) continue;
      if (prefix && end < prefix.offset) break;
      const value = source.slice(start, end);
      const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(value)?.[1];
      if (!opening) continue;
      const lastLine = value.slice(value.lastIndexOf("\n") + 1);
      const closing = new RegExp(`^ {0,3}${opening[0]}{${opening.length},}[ \\t]*$`);
      const separator = /^\n[ \t]*\n/.exec(source.slice(end))?.[0];
      if (!closing.test(lastLine) || !separator) continue;
      const offset = end + separator.length;
      const lineEnd = node.position?.end.line;
      if (lineEnd === undefined) continue;
      cached = {
        source: source.slice(0, offset),
        offset,
        line: lineEnd + 2,
        children: structuredClone(root.children.slice(0, index + 1)),
      };
      break;
    }
    return root;
  };
}

/** 每个流式渲染器一份缓存。额外的语法插件必须走普通 parser——这里不知道
 * 它们有没有全文档依赖。
 */
export function createIncrementalMarkdownPlugin(): Plugin<[], Root> {
  let parser: Parser | undefined;
  return function () {
    const original = this.parser;
    if (!original) return;
    parser ??= createIncrementalMarkdownParser((source, file) => original(source, file) as Root);
    const parseDocument = parser;
    // ReactMarkdown 每次渲染都新建 processor。它第一次 parse 才是文档本身，
    // 之后 transform 可能在同一 processor 上解析合成文本，那些 parse 不能读写
    // 文档的缓存。
    let documentParsed = false;
    this.parser = (source, file) => {
      if (documentParsed) return original(source, file);
      documentParsed = true;
      return parseDocument(source, file);
    };
  };
}
