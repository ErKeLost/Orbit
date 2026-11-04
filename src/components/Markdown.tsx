import { memo, useMemo, useSyncExternalStore } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import type { PluggableList } from "unified";
import { remarkMentions } from "../lib/remark-mentions";
import { createMarkdownComponents } from "./markdown/renderers";
import { rehypeHeadingIds } from "./markdown/markdownFragments";
import {
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_REMARK_PLUGINS,
  MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
} from "../shared/lib/markdown/pipeline";
import { createIncrementalMarkdownPlugin } from "../shared/lib/markdown/incremental";
import { normalizeLatexDelimiters } from "../shared/lib/markdown/latex";

/**
 * Markdown 渲染：react-markdown + t3code 那套 remark/rehype 管线
 * （`shared/lib/markdown/pipeline.ts`，逐条移植自 t3code submodule）。
 *
 * 与之前的 Streamdown 相比，换来的是可控：围栏语言、行内 code 的 path chip、
 * GitHub alert、表格外壳、标题锚点都由我们自己的 components map 决定，流式
 * 期间走增量解析而不是每个 token 重解析整篇。
 *
 * KaTeX（含 CSS 与 mhchem，约 950 KB）仍然只在回复里真的出现公式时才加载，
 * 纯文本回答不为它付任何代价。
 */
type MathPlugins = { remark: PluggableList; rehype: PluggableList };
let math: MathPlugins | null = null;
let mathLoading: Promise<void> | null = null;
const mathListeners = new Set<() => void>();

function loadMath() {
  if (math || mathLoading) return;
  mathLoading = Promise.all([
    import("remark-math"),
    import("rehype-katex"),
    import("katex/dist/katex.min.css"),
    import("katex/contrib/mhchem"),
  ]).then(([remarkMath, rehypeKatex]) => {
    math = { remark: [remarkMath.default], rehype: [rehypeKatex.default] };
    for (const listener of mathListeners) listener();
  });
}

function subscribeMath(onChange: () => void) {
  mathListeners.add(onChange);
  return () => {
    mathListeners.delete(onChange);
  };
}

const mathSnapshot = () => math;
const MATH_PATTERN = /\$\$|\\\[|\\\(|(^|[^\\$])\$[^\s$][^$\n]*\$/;
/** 流式增量解析只在文档里已经有围栏时才有意义；没有围栏的短回答直接整篇解析。 */
const FENCE_PATTERN = /(?:^|\n) {0,3}(?:`{3}|~{3})/;

/** 导出让测试与 SSR 等到 KaTeX 到位。 */
export function preloadMath() {
  loadMath();
  return mathLoading ?? Promise.resolve();
}

/** `file:` 指向本地文件（PathChip 之外的兜底），其余交给 react-markdown 自己的白名单。 */
function urlTransform(url: string) {
  return /^file:/i.test(url) ? url : defaultUrlTransform(url);
}

export const Markdown = memo(function Markdown({
  content,
  animated = false,
  className = "",
  links = "external",
  lineBreaks = false,
}: {
  content: string;
  animated?: boolean;
  className?: string;
  links?: "external" | "panel";
  lineBreaks?: boolean;
}) {
  const settleDelay = animated ? 180 : 0;
  const hasMath = MATH_PATTERN.test(content);
  const plugins = useSyncExternalStore(subscribeMath, mathSnapshot, mathSnapshot);
  if (hasMath && !plugins) loadMath();

  const source = hasMath ? normalizeLatexDelimiters(content) : content;
  // 增量解析的缓存必须活过重渲染，所以插件实例按「数学插件是否已在管线里」稳定化：
  // 数学插件是异步装上的，装上前缓存下来的树没有公式，必须换一份。
  const incremental = useMemo(() => createIncrementalMarkdownPlugin(), [plugins]);

  const remarkPlugins = useMemo(() => {
    const base = lineBreaks ? MARKDOWN_REMARK_PLUGINS_WITH_BREAKS : MARKDOWN_REMARK_PLUGINS;
    const list: PluggableList = [remarkMentions, ...base];
    if (hasMath && plugins) list.unshift(...plugins.remark);
    if (animated && FENCE_PATTERN.test(source)) list.push(incremental);
    return list;
  }, [animated, hasMath, incremental, lineBreaks, plugins, source]);

  const rehypePlugins = useMemo(() => {
    const list: PluggableList = [...MARKDOWN_REHYPE_PLUGINS, rehypeHeadingIds];
    if (hasMath && plugins) list.push(...plugins.rehype);
    return list;
  }, [hasMath, plugins]);

  const components = useMemo(() => createMarkdownComponents(settleDelay), [settleDelay]);

  return (
    <div
      // 链接该开在哪个表面：data 属性而不是 prop，`a` 组件才能保持稳定身份。
      data-link-surface={links}
      data-streaming={animated ? "" : undefined}
      className={`agent-markdown chat-markdown min-w-0 font-sans text-sm leading-6 ${className} ${animated ? "is-streaming" : "markdown-static"}`.trim()}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        urlTransform={urlTransform}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});
