import { useEffect, type RefObject } from "react";

/**
 * macOS 上 Tauri 使用系统 WKWebView。WebKit 绘制原生选区时会额外填充
 * “selection gaps”（RenderBlock::blockSelectionGap / logicalRightSelectionGap）：
 * 行尾到容器右边缘、段落之间、表格单元格周围都会被涂满选区色。
 * Chromium（Codex 等 Electron 应用）不画这些间隙，所以选区只包住文字。
 *
 * 做法：聊天区原生 ::selection 设为透明（间隙随之透明），再用
 * CSS Custom Highlight API 把同一选区只画在文字上。选区本身、复制、
 * 拖选行为都保持原生，只替换绘制。
 */
const HIGHLIGHT_NAME = "chat-selection";

export function useSelectionHighlight(rootRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = rootRef.current;
    const highlights = typeof CSS !== "undefined" ? CSS.highlights : undefined;
    if (!root || !highlights || typeof Highlight === "undefined") return;
    root.classList.add("custom-selection-highlight");
    let frame = 0;
    const sync = () => {
      frame = 0;
      const selection = document.getSelection();
      const ranges: Range[] = [];
      if (selection && !selection.isCollapsed) {
        for (let index = 0; index < selection.rangeCount; index++) {
          const range = selection.getRangeAt(index);
          if (root.contains(range.commonAncestorContainer) || range.intersectsNode(root)) ranges.push(range.cloneRange());
        }
      }
      if (ranges.length) highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges));
      else highlights.delete(HIGHLIGHT_NAME);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(sync); };
    document.addEventListener("selectionchange", schedule);
    return () => {
      document.removeEventListener("selectionchange", schedule);
      if (frame) cancelAnimationFrame(frame);
      highlights.delete(HIGHLIGHT_NAME);
      root.classList.remove("custom-selection-highlight");
    };
  }, [rootRef]);
}
