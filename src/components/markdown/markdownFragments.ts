/**
 * 标题锚点。GitHub README 里的 `#install` 必须能跳到本页对应的标题，而在桌面
 * 应用里跟随 fragment 会改掉 hash 路由、直接把线程换掉，所以点击要拦下来自己滚。
 *
 * id 加在 sanitize 之后（清洗会剥 id），并统一带 `user-content-` 前缀，避免和
 * 应用自身的元素 id 撞车；查找时把前缀剥掉再比。
 */
import type { MouseEvent as ReactMouseEvent } from "react";

const SANITIZED_FRAGMENT_PREFIX = "user-content-";

interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function hastPlainText(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastPlainText).join("");
}

function githubHeadingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

export function rehypeHeadingIds() {
  return (tree: HastNode) => {
    const taken = new Set<string>();
    const collect = (node: HastNode) => {
      const id = node.properties?.id;
      if (typeof id === "string") taken.add(id);
      node.children?.forEach(collect);
    };
    collect(tree);
    const nextSuffix = new Map<string, number>();
    const visit = (node: HastNode) => {
      if (node.type === "element" && node.tagName && /^h[1-6]$/.test(node.tagName)) {
        const slug = githubHeadingSlug(hastPlainText(node));
        if (node.properties?.id === undefined && slug) {
          let count = nextSuffix.get(slug) ?? 0;
          let id = `${SANITIZED_FRAGMENT_PREFIX}${slug}`;
          while (taken.has(id)) {
            count += 1;
            id = `${SANITIZED_FRAGMENT_PREFIX}${slug}-${count}`;
          }
          nextSuffix.set(slug, count);
          taken.add(id);
          node.properties = { ...node.properties, id };
        }
        return;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

function normalizeId(id: string): string {
  let normalized = id;
  while (normalized.startsWith(SANITIZED_FRAGMENT_PREFIX)) {
    normalized = normalized.slice(SANITIZED_FRAGMENT_PREFIX.length);
  }
  return normalized;
}

export function handleMarkdownFragmentClick(
  event: ReactMouseEvent<HTMLAnchorElement>,
  href: string,
): void {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }

  let decoded = href.slice(1);
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // 保留原样：解析不了的 id 直接按字面量找。
  }
  const normalized = normalizeId(decoded);
  const matches = (element: HTMLElement) =>
    element.id === decoded || normalizeId(element.id) === normalized;

  const anchor = event.currentTarget;
  event.preventDefault();
  const localTarget = Array.from(
    anchor.closest<HTMLElement>(".agent-markdown")?.querySelectorAll<HTMLElement>("[id]") ?? [],
  ).find(matches);
  const target = localTarget ?? document.getElementById(decoded);
  target?.scrollIntoView({ block: "start" });
}
