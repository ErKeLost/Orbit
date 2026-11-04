/**
 * react-markdown 的 components map。移植自 t3code `apps/web/src/components/ChatMarkdown.tsx`，
 * 保留它对每个标签的处理方式（相同的标题层级、列表 gutter、GitHub alert、
 * 表格外壳、行内 code 的 path chip），去掉只有 t3code 自己才认识的东西：
 * 线程链接、PR 链接、artifact 模板、skill chip、远端媒体。
 *
 * 组件类型必须稳定：流式渲染时 Markdown 每帧都会重跑，一旦 `a` 换了新的函数
 * 身份，页面上每个链接都会重新挂载、丢掉焦点和 hover。
 */
import { InfoIcon, LightbulbIcon, MessageSquareWarningIcon, OctagonAlertIcon, TriangleAlertIcon } from "lucide-react";
import { Children, createElement, type ComponentPropsWithoutRef, type ComponentType, type CSSProperties, type ElementType, type ReactNode } from "react";
import type { Components, ExtraProps } from "react-markdown";
import { MarkdownLink, Pre } from "../CodeBlock";
import { PathChip } from "../PathChip";
import { MarkdownTable } from "./MarkdownTable";
import { handleMarkdownFragmentClick } from "./markdownFragments";
import { MarkdownFileLink, filePathFromHref } from "./MarkdownFileLink";
import { navigatesWebview } from "../../lib/link-safety";
import { MarkdownImage } from "./MarkdownMedia";
import { ExternalLinkContent, plainTextOf } from "./MarkdownLinkFavicon";

function selectableText(children: ReactNode) {
  return Children.map(children, (child) =>
    typeof child === "string" ? <span className="md-selectable-text">{child}</span> : child,
  );
}

function selectableElement<T extends ElementType>(tag: T) {
  return ({ node: _node, children, ...props }: ComponentPropsWithoutRef<T> & { node?: unknown }) =>
    createElement(tag, props, selectableText(children));
}

function heading(level: 1 | 2 | 3 | 4 | 5 | 6) {
  const Tag = `h${level}` as const;
  return function MarkdownHeading({ node: _node, ...props }: ComponentPropsWithoutRef<typeof Tag> & ExtraProps) {
    return <Tag {...props} />;
  };
}

const GITHUB_ALERT_PRESENTATIONS: Record<
  string,
  { label: string; Icon: ComponentType<{ size?: number | string; className?: string; "aria-hidden"?: boolean }> }
> = {
  note: { label: "注意", Icon: InfoIcon },
  tip: { label: "提示", Icon: LightbulbIcon },
  important: { label: "重要", Icon: MessageSquareWarningIcon },
  warning: { label: "警告", Icon: TriangleAlertIcon },
  caution: { label: "当心", Icon: OctagonAlertIcon },
};

function orderedListGutterStyle(itemCount: number, start: unknown): CSSProperties | undefined {
  const parsedStart = Number.parseInt(String(start ?? 1), 10);
  const firstNumber = Number.isNaN(parsedStart) ? 1 : parsedStart;
  const lastNumber = firstNumber + Math.max(itemCount - 1, 0);
  const markerWidth = Math.max(String(firstNumber).length, String(lastNumber).length);
  if (markerWidth <= 1) return undefined;
  return { "--list-gutter": `${markerWidth + 2}ch` } as CSSProperties;
}

function readAlertKind(node: ExtraProps["node"] | undefined): string | undefined {
  const properties = (node as { properties?: Record<string, unknown> } | undefined)?.properties;
  const value = properties?.dataAlert;
  return typeof value === "string" ? value : undefined;
}

export function createMarkdownComponents(settleDelay: number): Components {
  return {
    h1: heading(1),
    h2: heading(2),
    h3: heading(3),
    h4: heading(4),
    h5: heading(5),
    h6: heading(6),
    p: selectableElement("p"),
    li: selectableElement("li"),
    td: selectableElement("td"),
    th: selectableElement("th"),
    blockquote: function MarkdownBlockquote({ node, children, ...props }) {
      const kind = readAlertKind(node);
      const alert = kind ? GITHUB_ALERT_PRESENTATIONS[kind] : undefined;
      if (!kind || !alert) return <blockquote {...props}>{children}</blockquote>;
      const { Icon } = alert;
      return (
        <blockquote {...props} className={`md-alert md-alert-${kind}`}>
          <p className="md-alert-title">
            <Icon size={14} aria-hidden />
            <span>{alert.label}</span>
          </p>
          {children}
        </blockquote>
      );
    },
    ol: function MarkdownOrderedList({ node, start, style, ...props }) {
      const itemCount =
        node?.children?.filter((child) => child.type === "element" && child.tagName === "li").length ?? 0;
      const gutterStyle = orderedListGutterStyle(itemCount, start);
      return <ol {...props} start={start} style={gutterStyle ? { ...style, ...gutterStyle } : style} />;
    },
    input: function MarkdownInput({ node: _node, type, checked, disabled: _disabled, ...props }) {
      if (type !== "checkbox") return <input {...props} type={type} />;
      return <input {...props} type="checkbox" checked={checked} disabled readOnly />;
    },
    a: function MarkdownAnchor({ node: _node, href, children, ...props }) {
      if (href?.startsWith("#")) {
        // 桌面应用的 hash 就是路由：跟随 fragment 会把线程换掉。
        return (
          <a {...props} href={href} onClick={(event) => handleMarkdownFragmentClick(event, href)}>
            {children}
          </a>
        );
      }
      // 指向文件的链接画成带类型图标的 chip，和 t3code 一样：蓝色下划线是给
      // 网页的，文件该看起来像文件。
      if (filePathFromHref(href)) {
        return <MarkdownFileLink href={href}>{children}</MarkdownFileLink>;
      }
      // `data:` / `blob:` / `file:` 这类链接点了会把整个 webview 换成那份文档，
      // 应用就回不来了（XML 类型的目标还会直接显示浏览器解析错误页）。画成不可点的
      // 文字，把原地址留在 title 上，至少能看出来它指向什么。
      if (navigatesWebview(href ?? "")) {
        return <span className="text-content/60" title={href}>{children}</span>;
      }
      const plainText = plainTextOf(children);
      const external = Boolean(href && /^https?:\/\//i.test(href));
      return (
        <MarkdownLink href={href} {...props}>
          {external ? (
            <ExternalLinkContent href={href} plainText={plainText}>
              {children}
            </ExternalLinkContent>
          ) : (
            children
          )}
        </MarkdownLink>
      );
    },
    img: function MarkdownImg({ node, src, alt, title }) {
      const properties = (node as { properties?: Record<string, unknown> } | undefined)?.properties;
      const markdownTitle = properties?.dataMarkdownTitle;
      const standalone = properties?.dataStandalone === true;
      return (
        <MarkdownImage
          src={typeof src === "string" ? src : undefined}
          alt={alt ?? ""}
          title={typeof markdownTitle === "string" ? markdownTitle : title}
          standalone={standalone}
        />
      );
    },
    code: function MarkdownCode({ node, className, children, ...props }) {
      // 围栏代码到达这里时带着 language-* 类名和换行；chip 只处理单个行内 token。
      // 链接里的行内 code 不带标记，也就不会在 <a> 里塞一个 <button>。
      const inlineCode = (node as { properties?: Record<string, unknown> } | undefined)?.properties;
      const tagged = inlineCode?.dataInlineCode !== undefined;
      if (!tagged || className || (typeof children === "string" && children.includes("\n"))) {
        return (
          <code className={className} {...props}>
            {children}
          </code>
        );
      }
      return (
        <PathChip className={className} {...props}>
          {children}
        </PathChip>
      );
    },
    pre: function MarkdownPre(props) {
      return <Pre {...props} settleDelay={settleDelay} />;
    },
    table: MarkdownTable,
  };
}
