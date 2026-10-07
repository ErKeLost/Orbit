import { Streamdown, preprocessLaTeX } from "@lobehub/streamdown";
import { Children, createElement, useMemo, useSyncExternalStore, type ComponentPropsWithoutRef, type ElementType, type ReactNode } from "react";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";
import { remarkMentions } from "../lib/remark-mentions";
import { MarkdownLink, Pre } from "./CodeBlock";
import { isLowPerf } from "../lib/perf-tier";

/**
 * KaTeX (~950 KB with its CSS and mhchem) loads the first time a reply
 * actually contains math, the same "after first paint" rule MonoCode applies
 * to its heavy assets. Plain replies never pay for it.
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

/** Exported for tests and SSR: resolves once KaTeX has been loaded. */
export function preloadMath() {
  loadMath();
  return mathLoading ?? Promise.resolve();
}

const baseRemark: PluggableList = [remarkGfm, remarkMentions];

function selectableText(children: ReactNode) {
  return Children.map(children, (child) => (typeof child === "string" ? <span className="md-selectable-text">{child}</span> : child));
}

function selectableElement<T extends ElementType>(tag: T) {
  return ({ node: _node, children, ...props }: ComponentPropsWithoutRef<T> & { node?: unknown }) =>
    createElement(tag, props, selectableText(children));
}

const textComponents = {
  p: selectableElement("p"),
  li: selectableElement("li"),
  h1: selectableElement("h1"),
  h2: selectableElement("h2"),
  h3: selectableElement("h3"),
  h4: selectableElement("h4"),
  h5: selectableElement("h5"),
  h6: selectableElement("h6"),
  td: selectableElement("td"),
  th: selectableElement("th"),
};

/**
 * Markdown keeps Orbit's renderer (LobeHub Streamdown + remark + the Shiki
 * `Pre` block) and takes MonoCode's typography through `.agent-markdown`.
 */
export function Markdown({ content, animated = false, className = "" }: { content: string; animated?: boolean; className?: string }) {
  const settleDelay = animated ? 180 : 0;
  const hasMath = MATH_PATTERN.test(content);
  const plugins = useSyncExternalStore(subscribeMath, mathSnapshot, mathSnapshot);
  if (hasMath && !plugins) loadMath();
  const remarkPlugins = useMemo(() => (hasMath && plugins ? [...baseRemark, ...plugins.remark] : baseRemark), [hasMath, plugins]);
  const rehypePlugins = useMemo(() => (hasMath && plugins ? plugins.rehype : []), [hasMath, plugins]);
  const components = useMemo(
    () => ({
      ...textComponents,
      a: MarkdownLink,
      pre: (props: Parameters<typeof Pre>[0]) => <Pre {...props} settleDelay={settleDelay} />,
    }),
    [settleDelay],
  );

  return (
    <div className={`agent-markdown min-w-0 font-sans text-sm leading-6 ${className} ${animated ? "is-streaming" : "markdown-static"}`.trim()}>
      <Streamdown
        content={content}
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        latexGuard={hasMath}
        preprocess={hasMath ? preprocessLaTeX : undefined}
        granularity="word"
        smoothing={isLowPerf ? "silky" : "balanced"}
        components={components}
      />
    </div>
  );
}
