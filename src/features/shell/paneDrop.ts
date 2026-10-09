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
