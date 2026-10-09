/**
 * Orbit's pane tree, ported from Orbit's
 * `features/workspace/model/layout.ts` (the parts a single workspace needs).
 *
 * A workspace is one tree: `split` nodes divide space along `right` (columns)
 * or `down` (rows) with fractional `sizes`, and `leaf` nodes are panes. Leaves
 * are rendered absolutely from `layoutLeaves`, `layoutSashes` covers every
 * boundary with a draggable sash, and panes move between edges with `movePane`.
 */

export type SplitDir = "right" | "down";
export type PanePlace = "before" | "after";
export type PaneEdge = "left" | "right" | "top" | "bottom";

export type LayoutNode =
  | { type: "leaf"; id: string }
  | {
      type: "split";
      id: string;
      dir: SplitDir;
      children: LayoutNode[];
      sizes: number[];
    };

export type LayoutRect = { x: number; y: number; w: number; h: number };

export type LayoutLeaf = { id: string; rect: LayoutRect; axis: "x" | "y" };

export type LayoutSash = {
  splitId: string;
  index: number;
  dir: SplitDir;
  group: LayoutRect;
  sizes: number[];
};

/** Orbit `layout.ts` MIN_SIZE: no pane may be squeezed below 8% of its split. */
export const MIN_PANE_SHARE = 0.08;

export function leaf(id: string): LayoutNode {
  return { type: "leaf", id };
}

function split(dir: SplitDir, children: LayoutNode[]): LayoutNode {
  return {
    type: "split",
    id: `split-${crypto.randomUUID().slice(0, 8)}`,
    dir,
    children,
    sizes: equalSizes(children.length),
  };
}

function equalSizes(n: number): number[] {
  return Array.from({ length: n }, () => 1 / n);
}

function normalize(sizes: number[]): number[] {
  const total = sizes.reduce((sum, n) => sum + n, 0);
  if (total <= 0) return equalSizes(sizes.length);
  return sizes.map((n) => n / total);
}

export function leafIds(node: LayoutNode): string[] {
  if (node.type === "leaf") return [node.id];
  return node.children.flatMap(leafIds);
}

export function firstLeafId(node: LayoutNode): string {
  return node.type === "leaf" ? node.id : firstLeafId(node.children[0]);
}

export function siblingLeafId(node: LayoutNode, id: string): string | null {
  if (node.type === "leaf") return null;
  const index = node.children.findIndex(
    (child) => child.type === "leaf" && child.id === id,
  );
  if (index >= 0) {
    const neighbor = node.children[index - 1] ?? node.children[index + 1];
    return neighbor ? firstLeafId(neighbor) : null;
  }
  for (const child of node.children) {
    const found = siblingLeafId(child, id);
    if (found) return found;
  }
  return null;
}

export function layoutLeaves(
  node: LayoutNode,
  rect: LayoutRect = { x: 0, y: 0, w: 1, h: 1 },
  parentDir?: SplitDir,
): LayoutLeaf[] {
  const axis = parentDir === "down" ? "y" : "x";
  if (node.type === "leaf") return [{ id: node.id, rect, axis }];
  const row = node.dir === "right";
  let offset = 0;
  const out: LayoutLeaf[] = [];
  for (let i = 0; i < node.children.length; i++) {
    const size = node.sizes[i] ?? 0;
    const child: LayoutRect = row
      ? { x: rect.x + offset * rect.w, y: rect.y, w: size * rect.w, h: rect.h }
      : { x: rect.x, y: rect.y + offset * rect.h, w: rect.w, h: size * rect.h };
    offset += size;
    out.push(...layoutLeaves(node.children[i], child, node.dir));
  }
  return out;
}

export function layoutSashes(
  node: LayoutNode,
  rect: LayoutRect = { x: 0, y: 0, w: 1, h: 1 },
): LayoutSash[] {
  if (node.type === "leaf") return [];
  const row = node.dir === "right";
  let offset = 0;
  const out: LayoutSash[] = [];
  for (let i = 0; i < node.children.length; i++) {
    const size = node.sizes[i] ?? 0;
    if (i > 0) {
      out.push({
        splitId: node.id,
        index: i - 1,
        dir: node.dir,
        group: rect,
        sizes: node.sizes,
      });
    }
    const child: LayoutRect = row
      ? { x: rect.x + offset * rect.w, y: rect.y, w: size * rect.w, h: rect.h }
      : { x: rect.x, y: rect.y + offset * rect.h, w: rect.w, h: size * rect.h };
    offset += size;
    out.push(...layoutSashes(node.children[i], child));
  }
  return out;
}

function splitSizesAtBoundary(
  current: number[],
  index: number,
  boundary: number,
): number[] {
  if (index < 0 || index >= current.length - 1) return current;
  const sizes = [...current];
  const before = sizes.slice(0, index).reduce((sum, n) => sum + n, 0);
  const pair = sizes[index] + sizes[index + 1];
  const min = Math.min(MIN_PANE_SHARE, pair / 2);
  const first = Math.min(pair - min, Math.max(min, boundary - before));
  sizes[index] = first;
  sizes[index + 1] = pair - first;
  return sizes;
}

/** Move the sash between `index` and `index + 1` to `boundary` (0–1 of the group). */
export function setSplitRatio(
  node: LayoutNode,
  splitId: string,
  index: number,
  boundary: number,
): LayoutNode {
  if (node.type === "leaf") return node;
  if (node.id !== splitId) {
    return {
      ...node,
      children: node.children.map((child) =>
        setSplitRatio(child, splitId, index, boundary),
      ),
    };
  }
  if (index < 0 || index >= node.sizes.length - 1) return node;
  return { ...node, sizes: splitSizesAtBoundary(node.sizes, index, boundary) };
}

/** Drop a leaf. Parent splits collapse to the remaining child. */
export function removePane(node: LayoutNode, id: string): LayoutNode | null {
  if (node.type === "leaf") return node.id === id ? null : node;
  const kept: { child: LayoutNode; size: number }[] = [];
  for (let i = 0; i < node.children.length; i++) {
    const child = removePane(node.children[i], id);
    if (child) kept.push({ child, size: node.sizes[i] ?? 0 });
  }
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0].child;
  return {
    ...node,
    children: kept.map((item) => item.child),
    sizes: normalize(kept.map((item) => item.size)),
  };
}

function splitPaneRelative(
  node: LayoutNode,
  targetId: string,
  dir: SplitDir,
  newPaneId: string,
  before: boolean,
): LayoutNode {
  if (node.type === "leaf") {
    if (node.id !== targetId) return node;
    return split(
      dir,
      before ? [leaf(newPaneId), node] : [node, leaf(newPaneId)],
    );
  }

  const direct = node.children.findIndex(
    (child) => child.type === "leaf" && child.id === targetId,
  );
  if (direct >= 0) {
    if (node.dir === dir) {
      const insertAt = before ? direct : direct + 1;
      const children = [
        ...node.children.slice(0, insertAt),
        leaf(newPaneId),
        ...node.children.slice(insertAt),
      ];
      return { ...node, children, sizes: equalSizes(children.length) };
    }
    return {
      ...node,
      children: node.children.map((child, i) =>
        i === direct
          ? split(dir, before ? [leaf(newPaneId), child] : [child, leaf(newPaneId)])
          : child,
      ),
    };
  }

  return {
    ...node,
    children: node.children.map((child) =>
      splitPaneRelative(child, targetId, dir, newPaneId, before),
    ),
  };
}

/** Open a new pane on `targetId`'s edge (Orbit `splitPaneRelative`). */
export function placeNewPane(
  node: LayoutNode,
  targetId: string,
  newPaneId: string,
  edge: PaneEdge,
): LayoutNode {
  const { dir, place } = edgeSplit(edge);
  return splitPaneRelative(node, targetId, dir, newPaneId, place === "before");
}

export function paneEdgeFromPoint(
  x: number,
  y: number,
  rect: { left: number; top: number; width: number; height: number },
): PaneEdge {
  const nx = rect.width <= 0 ? 0 : (x - rect.left) / rect.width - 0.5;
  const ny = rect.height <= 0 ? 0 : (y - rect.top) / rect.height - 0.5;
  if (Math.abs(nx) > Math.abs(ny)) return nx < 0 ? "left" : "right";
  return ny < 0 ? "top" : "bottom";
}

export function edgeSplit(edge: PaneEdge): { dir: SplitDir; place: PanePlace } {
  if (edge === "left") return { dir: "right", place: "before" };
  if (edge === "right") return { dir: "right", place: "after" };
  if (edge === "top") return { dir: "down", place: "before" };
  return { dir: "down", place: "after" };
}

function leafParent(
  node: LayoutNode,
  leafId: string,
): { parentId: string; index: number; dir: SplitDir } | null {
  if (node.type === "leaf") return null;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.type === "leaf" && child.id === leafId) {
      return { parentId: node.id, index: i, dir: node.dir };
    }
    const found = leafParent(child, leafId);
    if (found) return found;
  }
  return null;
}

function reorderChild(
  node: Extract<LayoutNode, { type: "split" }>,
  fromIndex: number,
  toIndex: number,
  place: PanePlace,
): LayoutNode {
  const n = node.children.length;
  if (fromIndex < 0 || fromIndex >= n || toIndex < 0 || toIndex >= n) return node;
  let insertAt = place === "after" ? toIndex + 1 : toIndex;
  insertAt = Math.max(0, Math.min(n, insertAt));
  if (fromIndex < insertAt) insertAt -= 1;
  if (fromIndex === insertAt) return node;
  const children = [...node.children];
  const sizes = [...node.sizes];
  const [child] = children.splice(fromIndex, 1);
  const [size] = sizes.splice(fromIndex, 1);
  children.splice(insertAt, 0, child);
  sizes.splice(insertAt, 0, size);
  return { ...node, children, sizes };
}

function reorderInSplit(
  node: LayoutNode,
  splitId: string,
  fromIndex: number,
  toIndex: number,
  place: PanePlace,
): LayoutNode {
  if (node.type === "leaf") return node;
  if (node.id === splitId) return reorderChild(node, fromIndex, toIndex, place);
  return {
    ...node,
    children: node.children.map((child) =>
      reorderInSplit(child, splitId, fromIndex, toIndex, place),
    ),
  };
}

function extractLeaf(
  node: LayoutNode,
  leafId: string,
): { tree: LayoutNode | null; leaf: Extract<LayoutNode, { type: "leaf" }> } | null {
  if (node.type === "leaf") {
    return node.id === leafId ? { tree: null, leaf: node } : null;
  }
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  let found: Extract<LayoutNode, { type: "leaf" }> | null = null;
  for (let i = 0; i < node.children.length; i++) {
    const extracted = extractLeaf(node.children[i], leafId);
    if (!extracted) {
      children.push(node.children[i]);
      sizes.push(node.sizes[i] ?? 0);
      continue;
    }
    found = extracted.leaf;
    if (extracted.tree) {
      children.push(extracted.tree);
      sizes.push(node.sizes[i] ?? 0);
    }
  }
  if (!found) return null;
  if (children.length === 0) return { tree: null, leaf: found };
  if (children.length === 1) return { tree: children[0], leaf: found };
  return { tree: { ...node, children, sizes: normalize(sizes) }, leaf: found };
}

function insertBeside(
  node: LayoutNode,
  targetId: string,
  incoming: LayoutNode,
  place: PanePlace,
): LayoutNode {
  if (node.type === "leaf") return node;
  const index = node.children.findIndex(
    (child) => child.type === "leaf" && child.id === targetId,
  );
  if (index >= 0) {
    const insertAt = place === "before" ? index : index + 1;
    const children = [...node.children];
    const sizes = [...node.sizes];
    const share = (sizes[index] ?? 0) / 2;
    sizes[index] = share;
    children.splice(insertAt, 0, incoming);
    sizes.splice(insertAt, 0, share);
    return { ...node, children, sizes };
  }
  return {
    ...node,
    children: node.children.map((child) =>
      insertBeside(child, targetId, incoming, place),
    ),
  };
}

function wrapBeside(
  node: LayoutNode,
  targetId: string,
  incoming: LayoutNode,
  dir: SplitDir,
  place: PanePlace,
): LayoutNode {
  if (node.type === "leaf") {
    if (node.id !== targetId) return node;
    return split(dir, place === "before" ? [incoming, node] : [node, incoming]);
  }
  return {
    ...node,
    children: node.children.map((child) =>
      wrapBeside(child, targetId, incoming, dir, place),
    ),
  };
}

/**
 * Drag a leaf onto another pane's edge. Same-axis siblings only swap order; a
 * perpendicular edge nests a new split around the target.
 */
export function movePane(
  node: LayoutNode,
  fromId: string,
  toId: string,
  edge: PaneEdge,
): LayoutNode {
  if (fromId === toId) return node;
  const fromAt = leafParent(node, fromId);
  const toAt = leafParent(node, toId);
  if (!fromAt || !toAt) return node;

  const { dir, place } = edgeSplit(edge);
  if (toAt.dir === dir && fromAt.parentId === toAt.parentId) {
    return reorderInSplit(node, fromAt.parentId, fromAt.index, toAt.index, place);
  }

  const extracted = extractLeaf(node, fromId);
  if (!extracted?.tree) return node;
  if (!leafIds(extracted.tree).includes(toId)) return node;
  const targetAt = leafParent(extracted.tree, toId);
  if (targetAt?.dir === dir) {
    return insertBeside(extracted.tree, toId, extracted.leaf, place);
  }
  return wrapBeside(extracted.tree, toId, extracted.leaf, dir, place);
}
