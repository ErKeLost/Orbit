import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "../../lib/store";
import { mergeProjectSessions, useProjectSessions } from "../../hooks/use-project-sessions";
import { queryClient, report, retireSession } from "../../lib/rpc";
import { toast } from "../../shared/ui/toast";
import { compactTitle } from "../../lib/session-visual";
import { TabLabel } from "../../shared/ui/TabLabel";
import { useTabCloseMotion } from "../../shared/hooks/useTabCloseMotion";
import { TabWidthMotion } from "./ClosingTab";
import { useLockOverscroll } from "../../shared/hooks/useLockOverscroll";
import { ChevronLeft, ChevronRight, PanelLeft, Settings, Terminal, X } from "../../shared/ui/icons";
import { IS_MAC, MOD, TitleIconButton } from "./chrome";
import { TerminalSpinner } from "./TerminalSpinner";
import { useShell } from "./shellStore";

/** The strip holds the session only; every file tab lives in its own pane (`SurfaceTabs`). */
type Tab = { id: "session"; kind: "session"; headline: string; busy?: boolean };

function tabStripOverflow(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
): { left: boolean; right: boolean } {
  const maxScroll = scrollWidth - clientWidth;
  if (maxScroll <= 1) return { left: false, right: false };
  return {
    left: scrollLeft > 1,
    right: scrollLeft < maxScroll - 1,
  };
}

function TabStripChevron({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const label = side === "left" ? "向左滚动标签" : "向右滚动标签";
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-tauri-drag-region="false"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
      className={`absolute top-1/2 z-40 grid size-6.5 -translate-y-1/2 place-items-center rounded-md bg-content/10 backdrop-blur-xl text-content/70 hover:bg-content/15 hover:text-content ${
        side === "left" ? "left-1" : "right-1"
      }`}
    >
      <Icon className="size-3.5" strokeWidth={1.75} />
    </button>
  );
}

type TabMenu = { tabId: string; x: number; y: number } | null;

function TitleTabItem({
  tab,
  active,
  closable,
  onSelect,
  onClose,
  onContextMenu,
  itemRef,
}: {
  tab: Tab;
  active: boolean;
  closable: boolean;
  onSelect: () => void;
  onClose?: () => void;
  onContextMenu?: (event: React.MouseEvent<HTMLDivElement>) => void;
  itemRef?: (el: HTMLDivElement | null) => void;
}) {
  return (
    <div
      ref={itemRef}
      className="reorder-item tab-motion group @container relative flex h-full min-w-0 w-full cursor-default touch-none items-center self-stretch"
      data-tauri-drag-region="false"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu?.(event);
      }}
      onMouseDownCapture={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button !== 1 || !onClose) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <button
        type="button"
        title={tab.headline}
        aria-label={tab.headline}
        aria-current={active ? "true" : undefined}
        data-tauri-drag-region="false"
        onClick={onSelect}
        className={`relative flex h-7.5 min-w-0 flex-1 cursor-default items-center gap-1.5 self-center rounded-md px-2 text-left ${onClose ? "pr-7" : "pr-2.5"} ${
          active ? "bg-selection text-content" : "text-content/50 hover:bg-content/5 hover:text-content"
        }`}
      >
        {tab.busy ? (
          <TerminalSpinner className="inline-block w-3.5 select-none text-center text-[11px] leading-none text-accent" />
        ) : null}
        {/* Keep two-line tabs compact while leaving room for descenders. */}
        <span className="flex min-w-0 flex-1 flex-col justify-center">
          <span className="flex min-w-0 items-center gap-1">
            <TabLabel className="text-[13px] leading-tight">{tab.headline}</TabLabel>
          </span>
        </span>
      </button>
      {closable && onClose ? (
        <button
          type="button"
          title="关闭标签"
          aria-label={`关闭 ${tab.headline}`}
          data-no-drag
          data-tauri-drag-region="false"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          className="absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-content/50 opacity-0 hover:bg-content/10 hover:text-content group-hover:opacity-100"
        >
          <X className="size-3" strokeWidth={1.75} />
        </button>
      ) : null}
    </div>
  );
}

/**
 * MonoCode's title bar for the work area: the window title, the settings search
 * and the session itself. Open files live in their own pane's strip
 * (`SurfaceTabs`), not here — MonoCode keeps a pane's tabs inside the pane.
 */
export function TitleBar({ railsHidden }: { railsHidden: boolean }) {
  const cwd = useWorkspace((state) => state.cwd);
  const sessionFile = useWorkspace((state) => state.state?.sessionFile);
  const running = useWorkspace((state) => state.transcript.running);
  const liveSessions = useWorkspace((state) => state.liveSessions);
  const terminalOpen = useShell((state) => state.terminalOpen);
  const sessions = useProjectSessions(cwd);
  const merged = useMemo(() => mergeProjectSessions(cwd, sessions.data ?? [], liveSessions), [cwd, sessions.data, liveSessions]);
  const session = merged.sessions.find((item) => item.path === sessionFile);
  const sessionTitle = compactTitle(session?.name || session?.firstMessage, "新会话", 60);

  async function closeSession() {
    if (!session) return;
    try {
      await retireSession(session.path);
      await queryClient.invalidateQueries({ queryKey: ["pi", "sessions", cwd] });
      toast.success("会话已关闭");
    } catch (error) {
      report(error);
    }
  }

  const sessionTab: Tab = useMemo(
    () => ({ id: "session", kind: "session", headline: sessionTitle, busy: running }),
    [sessionTitle, running],
  );
  const tabs = useMemo(() => [sessionTab], [sessionTab]);

  const { displayed, setTabNode, finishMotion } = useTabCloseMotion(tabs);

  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const setTabStripRef = useCallback(
    (el: HTMLDivElement | null) => {
      tabStripRef.current = el;
      lockOverscroll(el);
    },
    [lockOverscroll],
  );
  const [tabOverflow, setTabOverflow] = useState({ left: false, right: false });
  const [tabMenu, setTabMenu] = useState<TabMenu>(null);
  const syncTabOverflow = useCallback(() => {
    const el = tabStripRef.current;
    const next = el
      ? tabStripOverflow(el.scrollLeft, el.clientWidth, el.scrollWidth)
      : { left: false, right: false };
    setTabOverflow((prev) =>
      prev.left === next.left && prev.right === next.right ? prev : next,
    );
  }, []);
  const scrollTabsBy = useCallback((direction: -1 | 1) => {
    const el = tabStripRef.current;
    if (!el) return;
    const amount = Math.max(el.clientWidth * 0.6, 112);
    el.scrollBy({ left: direction * amount, behavior: "smooth" });
  }, []);
  const activeTabRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({
      inline: "nearest",
      block: "nearest",
    });
  }, [sessionTab]);

  useLayoutEffect(() => {
    const el = tabStripRef.current;
    if (!el) return;
    syncTabOverflow();
    el.addEventListener("scroll", syncTabOverflow, { passive: true });
    const ro = new ResizeObserver(syncTabOverflow);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", syncTabOverflow);
      ro.disconnect();
    };
  }, [syncTabOverflow]);

  useLayoutEffect(() => {
    syncTabOverflow();
  }, [syncTabOverflow, sessionTab]);

  useEffect(() => {
    if (!tabMenu) return;
    const dismiss = () => setTabMenu(null);
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("blur", dismiss);
    };
  }, [tabMenu]);

  const menuTab = tabMenu ? tabs.find((tab) => tab.id === tabMenu.tabId) ?? null : null;
  const closeTabMenu = () => {
    void closeSession();
    setTabMenu(null);
  };

  return (
    <header className="flex h-10 shrink-0 select-none items-stretch border-b border-stroke" data-tauri-drag-region>
      {railsHidden ? (
        <>
          {IS_MAC ? <div className="w-[78px] shrink-0" /> : null}
          <div className="flex shrink-0 items-center px-1.5">
            <TitleIconButton label={`切换侧栏 (${MOD}B)`} onClick={() => { useShell.getState().setProjectRailOpen(true); useShell.getState().setSessionSidebarOpen(true); }}>
              <PanelLeft className="size-3.5" strokeWidth={1.75} />
            </TitleIconButton>
          </div>
        </>
      ) : null}
      <div className="flex min-w-0 flex-1 items-stretch">
        <div
          className="relative h-full min-w-0 flex-1 overflow-hidden"
          onWheel={(event) => {
            const el = tabStripRef.current;
            if (!el || el.scrollWidth <= el.clientWidth) return;
            if (event.deltaX === 0 && event.deltaY !== 0) {
              el.scrollLeft += event.deltaY;
            }
          }}
        >
          {tabOverflow.left ? <TabStripChevron side="left" onClick={() => scrollTabsBy(-1)} /> : null}
          {tabOverflow.right ? <TabStripChevron side="right" onClick={() => scrollTabsBy(1)} /> : null}
          <div
            ref={setTabStripRef}
            data-title-tab-strip
            className="scrollbar-none flex h-full min-w-0 cursor-default items-center gap-0.5 overflow-x-auto overflow-y-hidden overscroll-none pl-1.5 pr-2.5"
            data-tauri-drag-region
          >
            {displayed.map((entry) => {
              const tab = entry.item;
              const closable = !entry.closing && Boolean(session);
              const shell = (
                <div
                  ref={(el) => {
                    if (!entry.closing) setTabNode(tab.id, el);
                  }}
                  className={
                    entry.closing || entry.opening
                      ? "relative flex h-full w-full min-w-0 overflow-hidden items-center"
                      : "relative flex h-full w-56 min-w-28 shrink cursor-default items-center"
                  }
                  data-tauri-drag-region="false"
                >
                  <TitleTabItem
                    tab={tab}
                    active={!entry.closing}
                    closable={closable}
                    onSelect={() => useShell.getState().focusFile(null)}
                    onClose={session ? () => { void closeSession(); } : undefined}
                    onContextMenu={(event) =>
                      setTabMenu({ tabId: tab.id, x: event.clientX, y: event.clientY })
                    }
                    itemRef={
                      !entry.closing
                        ? (el) => {
                            activeTabRef.current = el;
                          }
                        : undefined
                    }
                  />
                </div>
              );
              if (entry.closing || entry.opening) {
                return (
                  <TabWidthMotion
                    key={tab.id}
                    phase={entry.closing ? "closing" : "opening"}
                    width={entry.width}
                    onFinish={() => finishMotion(tab.id)}
                  >
                    {shell}
                  </TabWidthMotion>
                );
              }
              return <div key={tab.id} className="contents">{shell}</div>;
            })}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 px-2" data-tauri-drag-region="false">
        <TitleIconButton
          label={terminalOpen ? "收起终端 (⌘J)" : "打开终端 (⌘J)"}
          active={terminalOpen}
          onClick={() => useShell.getState().setTerminalOpen(!terminalOpen)}
        >
          <Terminal className="size-3.5" strokeWidth={1.75} />
        </TitleIconButton>
        {railsHidden ? (
          <TitleIconButton label={`设置 (${MOD},)`} onClick={() => useWorkspace.getState().set({ panel: "settings", settingsPage: "general" })}>
            <Settings className="size-3.5" strokeWidth={1.75} />
          </TitleIconButton>
        ) : null}
      </div>
      {tabMenu && menuTab ? (
        <div
          role="menu"
          className="fixed z-50 min-w-44 overflow-hidden rounded-lg border border-stroke bg-background-base p-1 shadow-lg"
          style={{ left: Math.min(tabMenu.x, window.innerWidth - 200), top: Math.min(tabMenu.y, window.innerHeight - 140) }}
          data-tauri-drag-region="false"
        >
          <button
            type="button"
            role="menuitem"
            onClick={closeTabMenu}
            className="flex h-7 w-full items-center rounded-md px-2.5 text-left text-[12px] text-content hover:bg-content/8"
          >
            关闭会话
          </button>
        </div>
      ) : null}
    </header>
  );
}
