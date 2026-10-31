import { useCallback } from "react";
import { useDragResize } from "../../shared/hooks/useDragResize";
import { useAnimatedReorder } from "../../shared/hooks/useAnimatedReorder";
import { Globe, Plus, X } from "../../shared/ui/icons";
import { useShell } from "../shell/shellStore";
import { BrowserTab } from "./BrowserTab";
import { reportMenuFailure, showBrowserTabMenu } from "./browser-tab-menu";

/**
 * The browser column — Orbit's third column.
 *
 * It is a column of the **window**, not a pane and not a workspace's file tab.
 * The reason is the same one that made the terminal a dock: a page is a live
 * thing a person is reading. Splitting a pane, closing the conversation it was
 * opened from, switching workspace tabs or going into settings used to take the
 * page with it, because the tab entry lived inside a workspace's pane list.
 *
 * The page itself is a native child web view (`browser_view.rs`) placed at the
 * rectangle its `BrowserTab` reports; this component only owns the tab strip,
 * the column's width and which page is in front. Tabs that are not in front stay
 * mounted and their views stay alive — hidden, never destroyed (`BrowserTab`
 * hides a zero-sized stage, and only a closed tab reaches
 * `browser_view_reconcile`).
 */

const WIDTH_DEFAULT = 520;
const WIDTH_MIN = 320;

const maxWidth = () => Math.max(WIDTH_MIN, Math.floor(window.innerWidth * 0.7));

/** The tab strip's label for a page: its host, until the page reports its title. */
function tabName(url: string, title?: string) {
  if (title?.trim()) return title.trim();
  try {
    return new URL(url).host || "新标签页";
  } catch {
    return url || "新标签页";
  }
}

export function BrowserDock() {
  const open = useShell((state) => state.browserOpen);
  const tabs = useShell((state) => state.browserTabs);
  const active = useShell((state) => state.browserActive);
  const width = useShell((state) => state.browserWidth);
  const setWidth = useShell((state) => state.setBrowserWidth);
  const setOpen = useShell((state) => state.setBrowserOpen);
  const setActive = useShell((state) => state.setBrowserActive);
  const openBrowser = useShell((state) => state.openBrowser);
  const closeFile = useShell((state) => state.closeFile);
  const reorderBrowserTabs = useShell((state) => state.reorderBrowserTabs);
  /** 画中画里浮着的那一页：标签上给它一个记号，否则那一格会像是空的。 */
  const floatingTab = useShell((state) => state.browserPip?.tab ?? null);

  const resize = useDragResize({ min: WIDTH_MIN, max: maxWidth, defaultWidth: WIDTH_DEFAULT, initial: width, direction: "left", onCommit: setWidth });
  const sortable = useAnimatedReorder(tabs.map(tab => tab.path), reorderBrowserTabs);

  const shown = tabs.find((tab) => tab.path === active) ?? tabs[0] ?? null;

  const close = useCallback(
    (path: string) => {
      closeFile(path);
      // Closing the last page is closing the column: an empty browser is the
      // logo and an address bar nobody asked for.
      if (tabs.length <= 1) setOpen(false);
    },
    [closeFile, setOpen, tabs.length],
  );

  return (
    <section
      ref={resize.setPaneRef}
      data-browser-dock=""
      aria-label="浏览器"
      hidden={!open}
      // Reserve a real gutter: z-index cannot put a DOM handle above a native
      // sibling WebView. Its stage must begin beyond the whole grab area.
      style={{ width: resize.width, paddingLeft: 8 }}
      className="relative flex h-full min-h-0 min-w-0 shrink-0 flex-col border-l border-stroke bg-background-base"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整浏览器宽度"
        aria-valuenow={resize.width}
        aria-valuemin={WIDTH_MIN}
        aria-valuemax={maxWidth()}
        data-tauri-drag-region="false"
        tabIndex={0}
        onPointerDown={resize.onPointerDown}
        onDoubleClick={resize.onDoubleClick}
        className={`absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize touch-none select-none hover:bg-accent/15 ${resize.dragging ? "bg-accent/15" : ""}`}
      >
        <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-px bg-stroke" />
      </div>
      <div className="flex h-9 min-w-0 shrink-0 items-center border-b border-stroke">
        <div role="tablist" aria-label="浏览器标签" className="scrollbar-none flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overscroll-none pl-1.5 pr-2.5">
          {tabs.map((tab) => {
            const selected = shown?.path === tab.path;
            return (
              <div key={tab.path}
                ref={node => sortable.setItemRef(tab.path, node)}
                className="reorder-item tab-motion group relative flex h-full w-44 min-w-24 shrink touch-none select-none items-center"
                data-tauri-drag-region="false"
                onPointerDown={event => {
                  if (event.button !== 0 || (event.target as HTMLElement).closest("[data-no-drag]")) return;
                  setActive(tab.path);
                  sortable.onItemPointerDown(tab.path, event);
                }}
                onContextMenu={event => {
                  event.preventDefault();
                  event.stopPropagation();
                  void showBrowserTabMenu(tab.path, event.clientX, event.clientY).catch(reportMenuFailure);
                }}
                onAuxClick={event => {
                  if (event.button !== 1) return;
                  event.preventDefault();
                  event.stopPropagation();
                  close(tab.path);
                }}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  title={tabName(tab.url, tab.title)}
                  onClick={() => { if (!sortable.consumeClick()) setActive(tab.path); }}
                  className={`relative flex h-7.5 min-w-0 flex-1 cursor-default items-center gap-1.5 self-center rounded-md px-2 pr-7 text-left text-[13px] ${
                    selected ? "bg-selection text-content" : "text-content/50 hover:bg-content/5 hover:text-content"
                  }`}
                >
                  <Globe className="size-3.5 shrink-0" strokeWidth={1.75} />
                  {tab.audioMuted ? <span aria-label="标签页已静音" title="标签页已静音" className="text-[10px]">静音</span> : null}
                  <span className="min-w-0 flex-1 truncate">{tabName(tab.url, tab.title)}</span>
                  {tab.path === floatingTab ? (
                    <span
                      title="这一页在画中画里"
                      aria-label="这一页在画中画里"
                      className="size-1.5 shrink-0 rounded-full bg-accent/70"
                    />
                  ) : null}
                </button>
                <button
                  type="button"
                  title="关闭标签页"
                  aria-label={`关闭 ${tabName(tab.url, tab.title)}`}
                  data-no-drag
                  onPointerDown={event => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (sortable.consumeClick()) return;
                    close(tab.path);
                  }}
                  className="absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-content/50 opacity-0 hover:bg-content/10 hover:text-content group-hover:opacity-100"
                >
                  <X className="size-3" strokeWidth={1.75} />
                </button>
              </div>
            );
          })}
          <div className="min-w-4 flex-1" />
        </div>
        <div className="flex shrink-0 items-center gap-0.5 pr-1.5">
          <button
            type="button"
            title="新建标签页"
            aria-label="新建标签页"
            onClick={() => openBrowser("")}
            className="grid size-6.5 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content"
          >
            <Plus className="size-3.5" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            title="收起浏览器"
            aria-label="收起浏览器"
            onClick={() => setOpen(false)}
            className="grid size-6.5 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content"
          >
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>
      </div>
      <div className="relative min-h-0 min-w-0 flex-1">
        {tabs.map((tab) => (
          // Every tab stays mounted: a page that is merely not in front keeps its
          // scroll, its forms and its session, and only a zero-sized stage hides
          // the native view.
          //
          // `flex`, not a plain block: `BrowserTab`'s root is `flex-1`, and a
          // flex item in a block parent does not stretch — the root collapsed to
          // its toolbar's height, the stage measured 0×0, and `place()` parked
          // the view it had not created yet. The column then showed an empty
          // pane (and the app held no view at all).
          <div key={tab.path} hidden={tab.path !== shown?.path} className="absolute inset-0 flex min-h-0 min-w-0">
            <BrowserTab path={tab.path} url={tab.url} title={tab.title} active={tab.path === shown?.path} agent={tab.agent} />
          </div>
        ))}
      </div>
    </section>
  );
}
