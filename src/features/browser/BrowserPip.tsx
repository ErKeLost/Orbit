import { useCallback, useEffect, useRef } from "react";
import { Globe, PanelRight, X } from "../../shared/ui/icons";
import { claimBrowserSurface } from "../../lib/browser-surface";
import { useShell } from "../shell/shellStore";
import { useBrowserImportStatus } from "../../lib/browser-import";
import "../../styles/browser-channel.css";

/**
 * 画中画：浮在窗口上的那一页。
 *
 * 它**不是第二份页面**，而是同一个原生视图换了个矩形（`browser_view.rs` 的
 * `set_position` / `set_size`）。所以浮起来的页面仍然是那一页：滚动、选中、
 * 输入法、登录态全都在，agent 的通道也照样能驱动它——浮起来的只是它的位置。
 *
 * 代价只有一个：视图是窗口的子层，永远画在页面之上。所以工具条不能画在页面
 * **里面**（会被盖住），只能画在页面**上面**的那一条——于是这一行是 DOM，
 * 下面那块是原生视图。
 *
 * 谁来摆这个视图？列里的 `BrowserTab` 在页面属于列的时候摆它；页面属于画中画
 * 的时候，列里的那一份必须让位（否则两边会互相抢同一个视图的位置），所以两边
 * 都问 store：这一页现在归谁。
 */

function hostOf(url: string, title?: string) {
  if (title?.trim()) return title.trim();
  try {
    return new URL(url).host || "新标签页";
  } catch {
    return url || "新标签页";
  }
}

export function BrowserPip() {
  const pip = useShell((state) => state.browserPip);
  const tabs = useShell((state) => state.browserTabs);
  const dockBrowserPip = useShell((state) => state.dockBrowserPip);
  const moveBrowserPip = useShell((state) => state.moveBrowserPip);
  const closeFile = useShell((state) => state.closeFile);
  const setBrowserActive = useShell((state) => state.setBrowserActive);
  const stage = useRef<HTMLDivElement | null>(null);
  const place = useRef<() => void>(() => undefined);

  const tab = pip ? tabs.find((item) => item.path === pip.tab) : undefined;
  const path = pip?.tab ?? "";
  const url = tab?.url;
  const { busy: importing, revision: importRevision } = useBrowserImportStatus();

  /**
   * 把视图摆到卡片里那块空地。
   *
   * 位置变了要重新摆：画中画被拖动、被缩放，矩形就变了，而原生视图不参与
   * 页面布局，不会自己跟过来。
   */
  useEffect(() => {
    if (!path || importing) return;
    const element = stage.current;
    if (!element) return;
    const surface = claimBrowserSurface(path);
    let frame = 0;
    const sync = () => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      void surface.present({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }, url || undefined).catch(() => undefined);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(sync); };
    place.current = schedule;
    // Position changes while dragging; size also changes on viewport resize.
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener("resize", schedule);
    window.addEventListener("orbit:browser-profile-changed", schedule);
    sync();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener("resize", schedule); window.removeEventListener("orbit:browser-profile-changed", schedule); place.current = () => undefined; surface.release(); };
  }, [path, url, importing, importRevision]);
  useEffect(() => { place.current(); }, [pip]);
  useEffect(() => {
    if (!path) return;
    const constrain = () => {
      const current = useShell.getState().browserPip;
      if (!current) return;
      const width = Math.min(current.width, window.innerWidth), height = Math.min(current.height, window.innerHeight);
      moveBrowserPip({ width, height, x: Math.max(0, Math.min(current.x, window.innerWidth - width)), y: Math.max(0, Math.min(current.y, window.innerHeight - height)) });
    };
    window.addEventListener("resize", constrain);
    return () => window.removeEventListener("resize", constrain);
  }, [path, moveBrowserPip]);

  // 画中画在前，agent 的通道默认对它说话。
  const pipTab = pip?.tab;
  useEffect(() => {
    if (!pipTab) return;
    setBrowserActive(pipTab);
  }, [pipTab, setBrowserActive]);

  /** 拖动：抓着标题栏走，位置记在 store 里（画中画记得住自己停在哪）。 */
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const resize = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  const onDragDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !pip) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { dx: event.clientX - pip.x, dy: event.clientY - pip.y };
  }, [pip]);

  const onDragMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || !pip) return;
    const maxX = Math.max(0, window.innerWidth - pip.width);
    const maxY = Math.max(0, window.innerHeight - pip.height);
    moveBrowserPip({
      x: Math.min(maxX, Math.max(0, event.clientX - current.dx)),
      y: Math.min(maxY, Math.max(0, event.clientY - current.dy)),
    });
  }, [moveBrowserPip, pip]);

  const onDragUp = useCallback((event: React.PointerEvent<HTMLElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  /** 缩放：右下角一个把手。 */
  const onResizeDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !pip) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resize.current = { x: event.clientX, y: event.clientY, width: pip.width, height: pip.height };
  }, [pip]);

  const onResizeMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const current = resize.current;
    if (!current || !pip) return;
    moveBrowserPip({
      width: Math.max(280, Math.min(window.innerWidth - pip.x, current.width + event.clientX - current.x)),
      height: Math.max(220, Math.min(window.innerHeight - pip.y, current.height + event.clientY - current.y)),
    });
  }, [moveBrowserPip, pip]);

  const onResizeUp = useCallback((event: React.PointerEvent<HTMLElement>) => {
    resize.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  if (!pip || !tab) return null;

  return (
    <div
      data-browser-pip=""
      className="browser-pip"
      style={{ left: pip.x, top: pip.y, width: pip.width, height: pip.height }}
    >
      <header
        role="toolbar"
        aria-label="画中画"
        style={{ touchAction: "none" }}
        onPointerDown={onDragDown}
        onPointerMove={onDragMove}
        onPointerUp={onDragUp}
        onPointerCancel={onDragUp}
        onDoubleClick={dockBrowserPip}
        className="browser-pip-bar"
      >
        <Globe className="size-3.5 shrink-0 text-content/40" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate text-[12px] text-content/60" title={tab.url}>
          {hostOf(tab.url, tab.title)}
        </span>
        <button
          type="button"
          title="收回浏览器列"
          aria-label="收回浏览器列"
          onClick={dockBrowserPip}
          onPointerDown={event => event.stopPropagation()}
          className="grid size-6.5 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content"
        >
          <PanelRight className="size-3.5" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          title="关闭这一页"
          aria-label="关闭这一页"
          onClick={() => {
            closeFile(path);
            dockBrowserPip();
          }}
          onPointerDown={event => event.stopPropagation()}
          className="grid size-6.5 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content"
        >
          <X className="size-3.5" strokeWidth={1.75} />
        </button>
      </header>
      {/* 页面本体：这一块是空的，真正的页面是系统画在这个矩形上的原生视图。 */}
      <div className="browser-pip-stage">
        <div ref={stage} className="h-full w-full" aria-label="画中画页面" role="application" />
      </div>
      <span
        role="presentation"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
        className="browser-pip-grip"
        aria-hidden="true"
      />
    </div>
  );
}
