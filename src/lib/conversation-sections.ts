import { createElement, type ReactNode } from "react";

export function messageKind(element: HTMLElement): "title" | "section" | "body" {
  if (element.closest(".transcript-message.user")) return "title";
  if (element.matches(".turn-activity, .transcript-error, .transcript-compaction, .bash-execution-card")) return "section";
  return "body";
}

export function sectionText(node: Node): string {
  return sectionTextBounded(node, SECTION_TEXT_BUDGET).text;
}

/** 目录只需要开头的几十个字，全文是白花的：长会话里每次扫描都要把每个区块
 * 的整棵子树拼成字符串（加上 GC 压力），而展示用的预览框只有 8 行高。
 * 预算内的前缀与全文前缀逐字一致，所以判重和展示都不会变。 */
export const SECTION_TEXT_BUDGET = 800;

function sectionTextBounded(node: Node, budget: number): { text: string; truncated: boolean } {
  const parts: string[] = [];
  let used = 0;
  let truncated = false;
  const visit = (current: Node): void => {
    if (truncated) return;
    if (current.nodeType === 3) {
      const value = current.textContent ?? "";
      parts.push(value);
      used += value.length;
      if (used >= budget) truncated = true;
      return;
    }
    if (current.nodeType !== 1) return;
    const element = current as HTMLElement;
    if (element.matches('button, script, style, svg, [aria-hidden="true"], .md-code-header, .message-response-footer')) return;
    for (const child of Array.from(element.childNodes)) visit(child);
  };
  visit(node);
  return { text: parts.join(" ").replace(/[\s\u200B\uFEFF]+/g, " ").trim().slice(0, budget), truncated };
}

export function hasSectionMedia(element: HTMLElement) {
  return element.matches("img, pre, table") || Boolean(element.querySelector("img, pre, table"));
}

// Reuse the rendered Markdown structure without copying handlers, IDs or controls.
const previewTags = new Set("p strong em del s code pre blockquote ul ol li h1 h2 h3 h4 h5 h6 table thead tbody tr th td br hr".split(" "));

export function sectionPreviewAfterHeading(heading: HTMLElement): ReactNode {
  const children: ReactNode[] = [];
  let sibling = heading.nextElementSibling;
  let index = 0;
  while (sibling) {
    if (/^H[1-6]$/.test(sibling.tagName)) break;
    const preview = sectionPreview(sibling, `heading-preview-${index++}`);
    if (preview) children.push(preview);
    sibling = sibling.nextElementSibling;
  }
  return children.length ? createElement("div", { className: "proximity-preview-markdown" }, ...children) : null;
}

export function sectionPreview(node: Node, key = "preview"): ReactNode {
  return buildPreview(node, key, { used: 0, budget: SECTION_TEXT_BUDGET });
}

/** 与 sectionText 共用预算：预览框只显示开头几行，把整块内容都建出来既慢又会
 * 让“文本没变就不更新”的判重与展示不一致。 */
function buildPreview(node: Node, key: string, budget: { used: number; budget: number }): ReactNode {
  if (budget.used >= budget.budget) return null;
  if (node.nodeType === 3) {
    const value = node.textContent ?? "";
    budget.used += value.length;
    return value;
  }
  if (node.nodeType !== 1) return null;
  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();
  if (element.matches('button, script, style, svg, img, [aria-hidden="true"], .md-code-header')) return null;
  if (tag === "input") return element.hasAttribute("checked") ? "☑ " : "☐ ";
  const children = Array.from(element.childNodes, (child, index) => buildPreview(child, `${key}-${index}`, budget));
  return createElement(previewTags.has(tag) ? tag : "span", {
    key,
    ...(tag === "ol" && element.hasAttribute("start") ? { start: Number(element.getAttribute("start")) } : {}),
  }, ...children);
}
