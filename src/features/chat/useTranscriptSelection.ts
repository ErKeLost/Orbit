import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Orbit 的 `useTranscriptSelection`：监听聊天区文字选区，要求起止都在
 * 同一个回答块（`data-selectable-agent-response`）内，返回选区文本与
 * 视口矩形（供浮动菜单定位）。跨块/标题区的选择不产生菜单。
 */

export const SELECTABLE_AGENT_RESPONSE_ATTR = "data-selectable-agent-response";

export type TranscriptSelection = {
  text: string;
  rect: DOMRect;
};

type SelectionCandidate = {
  text: string;
  collapsed: boolean;
  anchorResponseId: string | null;
  focusResponseId: string | null;
};

function responseIdForNode(node: Node | null, root: HTMLElement): string | null {
  const element = node instanceof Element ? node : node?.parentElement;
  const response = element?.closest<HTMLElement>(`[${SELECTABLE_AGENT_RESPONSE_ATTR}]`);
  if (!response || !root.contains(response)) return null;
  return response.getAttribute(SELECTABLE_AGENT_RESPONSE_ATTR);
}

function validateTranscriptSelection(candidate: SelectionCandidate): string | null {
  const text = candidate.text.trim();
  if (!text || candidate.collapsed) return null;
  if (!candidate.anchorResponseId || !candidate.focusResponseId) return null;
  if (candidate.anchorResponseId !== candidate.focusResponseId) return null;
  return text;
}

function firstRangeRect(range: Range): DOMRect | null {
  const rects = range.getClientRects();
  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects.item(index);
    if (rect && (rect.width > 0 || rect.height > 0)) return rect;
  }
  const rect = range.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0 ? rect : null;
}

export function useTranscriptSelection(
  root: HTMLElement | null,
  enabled: boolean,
): {
  selection: TranscriptSelection | null;
  dismissSelection: () => void;
} {
  const [selection, setSelection] = useState<TranscriptSelection | null>(null);
  const frame = useRef<number | null>(null);

  const dismissSelection = useCallback(() => setSelection(null), []);

  useEffect(() => {
    if (!enabled || !root) {
      dismissSelection();
      return;
    }

    let pointerSelecting = false;

    const cancelFrame = () => {
      if (frame.current == null) return;
      window.cancelAnimationFrame(frame.current);
      frame.current = null;
    };
    const reportSelection = () => {
      frame.current = null;
      const nativeSelection = window.getSelection();
      if (!nativeSelection || nativeSelection.rangeCount === 0) {
        setSelection(null);
        return;
      }
      const text = validateTranscriptSelection({
        text: nativeSelection.toString(),
        collapsed: nativeSelection.isCollapsed,
        anchorResponseId: responseIdForNode(nativeSelection.anchorNode, root),
        focusResponseId: responseIdForNode(nativeSelection.focusNode, root),
      });
      const rect = text ? firstRangeRect(nativeSelection.getRangeAt(0)) : null;
      setSelection(text && rect ? { text, rect } : null);
    };
    const scheduleReport = () => {
      cancelFrame();
      frame.current = window.requestAnimationFrame(reportSelection);
    };
    const onPointerDown = (event: PointerEvent) => {
      pointerSelecting = responseIdForNode(event.target as Node, root) != null;
      if (pointerSelecting) cancelFrame();
    };
    const onPointerUp = () => {
      if (!pointerSelecting) return;
      pointerSelecting = false;
      scheduleReport();
    };
    const onPointerCancel = () => {
      pointerSelecting = false;
    };
    const onSelectionChange = () => {
      if (!pointerSelecting) scheduleReport();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift" || (event.shiftKey && event.key.startsWith("Arrow"))) {
        scheduleReport();
      }
    };

    document.addEventListener("pointerdown", onPointerDown, { passive: true });
    document.addEventListener("pointerup", onPointerUp, { passive: true });
    document.addEventListener("pointercancel", onPointerCancel, { passive: true });
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("keyup", onKeyUp);
    return () => {
      cancelFrame();
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerCancel);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keyup", onKeyUp);
    };
  }, [dismissSelection, enabled, root]);

  return { selection, dismissSelection };
}
