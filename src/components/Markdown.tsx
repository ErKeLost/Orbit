import { Streamdown, preprocessLaTeX } from "@lobehub/streamdown";
import { Children, createElement, useMemo, type ComponentPropsWithoutRef, type ElementType, type ReactNode } from "react";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import "katex/contrib/mhchem";
import { remarkMentions } from "../lib/remark-mentions";
import { MarkdownLink, Pre } from "./CodeBlock";

const remarkPlugins = [remarkGfm, remarkMath, remarkMentions];
const rehypePlugins = [rehypeKatex];

function selectableText(children: ReactNode) {
  return Children.map(children, child => typeof child === "string" ? <span className="md-selectable-text">{child}</span> : child);
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

export function Markdown({
  content,
  animated = false,
  className = "",
}: {
  content: string;
  animated?: boolean;
  className?: string;
}) {
  const settleDelay = animated ? 180 : 0;
  const components = useMemo(
    () => ({
      ...textComponents,
      a: MarkdownLink,
      pre: (props: Parameters<typeof Pre>[0]) => <Pre {...props} settleDelay={settleDelay} />,
    }),
    [settleDelay],
  );

  return (
    <div className={`${className} ${animated ? "is-streaming" : "markdown-static"}`.trim()}>
      <Streamdown
        content={content}
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        latexGuard
        preprocess={preprocessLaTeX}
        granularity="word"
        smoothing="balanced"
        components={components}
      />
    </div>
  );
}
