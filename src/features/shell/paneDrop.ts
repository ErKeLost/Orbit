import { useSyncExternalStore } from "react";
import { paneEdgeFromPoint, type PaneEdge } from "./paneLayout";

/**
 * Drag targets for the pane tree, ported from Orbit's
 * `features/workspace/model/paneDrop.ts`: hit-test the live DOM so the drop
 * targets stay correct while panes are absolutely positioned and resized.
 */

export type PaneDrop = { fromId: string; overId: string; edge: PaneEdge };

/** Where a file tab drag would land: another pane's strip, or a pane edge. */
export type TabDrop = {
  path: string;
  fromPane: string;
  toPane: string;
  /** Null when the tab would join the pane's strip; set when it splits one off. */
  edge: PaneEdge | null;
};

export function paneDropFromPoint(x: number, y: number): { id: string; edge: PaneEdge } | null {
  const element = document.elementFromPoint(x, y);
  const pane = element?.closest("[data-pane-id]") as HTMLElement | null;
  const id = pane?.dataset.paneId;
  if (!id || !pane) return null;
  return { id, edge: paneEdgeFromPoint(x, y, pane.getBoundingClientRect()) };
}

/** 把整个面板拖进标题栏某个标签页的前后（monocode 的 TitleTabDrop）。 */
export type TitleTabDropPosition = "before" | "after";
export type TitleTabDrop = { fromId: string; targetTabId: string; position: TitleTabDropPosition };

/** 面板拖拽进行中时，标题栏在目标标签页上显示的插入位置提示。 */
let titleTabDrop: TitleTabDrop | null = null;
const titleTabListeners = new Set<() => void>();

export function setTitleTabDrop(next: TitleTabDrop | null) {
  if (
    titleTabDrop?.fromId === next?.fromId &&
    titleTabDrop?.targetTabId === next?.targetTabId &&
    titleTabDrop?.position === next?.position
  ) {
    return;
  }
  if (titleTabDrop == null && next == null) return;
  titleTabDrop = next;
  for (const listener of titleTabListeners) listener();
}

function subscribeTitleTabDrop(listener: () => void) {
  titleTabListeners.add(listener);
  return () => {
    titleTabListeners.delete(listener);
  };
}

function getTitleTabDrop(): TitleTabDrop | null {
  return titleTabDrop;
}

/** 插入提示：面板正被拖向标题栏的某个标签页时非空。 */
export function useTitleTabDrop() {
  return useSyncExternalStore(subscribeTitleTabDrop, getTitleTabDrop, getTitleTabDrop);
}

/** 解析面板应插到标题栏哪个标签页的哪一侧；指针不在标签页条上时返回 null。 */
export function titleTabDropFromPoint(x: number, y: number): { targetTabId: string; position: TitleTabDropPosition } | null {
  const element = document.elementFromPoint(x, y);
  const strip = element?.closest("[data-title-tab-strip]") as HTMLElement | null;
  if (!strip) return null;

  const tabs = Array.from(strip.querySelectorAll<HTMLElement>("[data-title-tab-id]"));
  if (tabs.length === 0) return null;

  const direct = element?.closest("[data-title-tab-id]") as HTMLElement | null;
  const target =
    direct && strip.contains(direct)
      ? direct
      : tabs.reduce((nearest, tab) => {
          const center = (tab.getBoundingClientRect().left + tab.getBoundingClientRect().right) / 2;
          const nearestCenter = (nearest.getBoundingClientRect().left + nearest.getBoundingClientRect().right) / 2;
          return Math.abs(x - center) < Math.abs(x - nearestCenter) ? tab : nearest;
        });
  const targetTabId = target.dataset.titleTabId;
  if (!targetTabId) return null;
  const rect = target.getBoundingClientRect();
  return { targetTabId, position: x < rect.left + rect.width / 2 ? "before" : "after" };
}

export function tabDropFromPoint(
  x: number,
  y: number,
  skip?: (element: Element) => boolean,
): { toPane: string; edge: PaneEdge | null } | null {
  // A dragged tab follows the pointer, so the topmost hit is often the tab
  // itself: walk down until something that is not being dragged shows up.
  for (const element of document.elementsFromPoint(x, y)) {
    if (skip?.(element)) continue;
    const strip = element.closest("[data-tab-strip]") as HTMLElement | null;
    if (strip?.dataset.tabStrip) return { toPane: strip.dataset.tabStrip, edge: null };
    const pane = element.closest("[data-pane-id]") as HTMLElement | null;
    if (pane?.dataset.paneId) {
      return { toPane: pane.dataset.paneId, edge: paneEdgeFromPoint(x, y, pane.getBoundingClientRect()) };
    }
  }
  return null;
}

let tabDrop: TabDrop | null = null;
const listeners = new Set<() => void>();

export function setTabDrop(next: TabDrop | null) {
  if (
    tabDrop?.path === next?.path &&
    tabDrop?.toPane === next?.toPane &&
    tabDrop?.edge === next?.edge
  ) {
    return;
  }
  if (tabDrop == null && next == null) return;
  tabDrop = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return tabDrop;
}

export function useTabDrop() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
