import { useMemo } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useWorkspace } from "../../lib/store";
import { mergeProjectSessions, useProjectSessions } from "../../hooks/use-project-sessions";
import { queryClient, report, retireSession } from "../../lib/rpc";
import { toast } from "../../shared/ui/toast";
import { compactTitle } from "../../lib/session-visual";
import { TabLabel } from "../../shared/ui/TabLabel";
import { useAnimatedReorder } from "../../shared/hooks/useAnimatedReorder";
import { GripVertical, PanelLeft, Settings, Terminal, X } from "../../shared/ui/icons";
import { FileTypeIcon } from "./FileTypeIcon";
import { IS_MAC, MOD, TitleIconButton } from "./chrome";
import { TerminalSpinner } from "./TerminalSpinner";
import { useShell, type OpenFile } from "./shellStore";

type SortableApi = ReturnType<typeof useAnimatedReorder>;

type Tab =
  | { id: "session"; kind: "session"; headline: string; busy?: boolean }
  | { id: string; kind: "file"; headline: string; preview?: boolean; fileName: string };

function TitleTab({
  tab,
  active,
  sortable,
  canDrag,
  onSelect,
  onClose,
  onPin,
}: {
  tab: Tab;
  active: boolean;
  sortable?: SortableApi;
  canDrag?: boolean;
  onSelect: () => void;
  onClose?: () => void;
  onPin?: () => void;
}) {
  const dragging = sortable?.draggingId === tab.id;
  return (
    <div
      ref={sortable ? (el) => sortable.setItemRef(tab.id, el) : undefined}
      className="reorder-item tab-motion group @container relative flex h-full w-56 min-w-28 shrink cursor-default touch-none items-center self-stretch"
      data-tauri-drag-region="false"
      onMouseDownCapture={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button !== 1 || !onClose) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        if ((event.target as HTMLElement | null)?.closest("[data-no-drag]")) return;
        if (canDrag && sortable) sortable.onItemPointerDown(tab.id, event);
      }}
    >
      <div className="relative flex h-full min-w-0 w-full cursor-default items-center self-stretch" data-tauri-drag-region="false">
        <button
          type="button"
          title={tab.headline}
          aria-label={tab.headline}
          aria-current={active ? "true" : undefined}
          data-tauri-drag-region="false"
          onClick={() => {
            if (sortable?.consumeClick()) return;
            onSelect();
          }}
          onDoubleClick={() => {
            if (tab.kind === "file" && tab.preview) onPin?.();
          }}
          className={`relative flex h-7.5 min-w-0 flex-1 cursor-default items-center gap-1.5 self-center rounded-md px-2 text-left ${onClose ? "pr-7" : "pr-2.5"} ${
            active ? "bg-selection text-content" : "text-content/50 hover:bg-content/5 hover:text-content"
          }`}
        >
          {canDrag ? (
            <span
              aria-hidden
              className={`mr-0.5 flex shrink-0 items-center text-content/30 transition-opacity ${dragging ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
            >
              <GripVertical className="size-3" strokeWidth={2} />
            </span>
          ) : null}
          {tab.kind === "session" ? (
            tab.busy ? <TerminalSpinner className="inline-block w-3.5 select-none text-center text-[11px] leading-none text-accent" /> : null
          ) : (
            <span className={!active ? "opacity-55" : undefined}>
              <FileTypeIcon name={tab.fileName} isDir={false} size={14} />
            </span>
          )}
          <span className="flex min-w-0 flex-1 flex-col justify-center">
            <span className="flex min-w-0 items-center gap-1">
              <TabLabel className={`leading-tight ${tab.kind === "file" && tab.preview ? "italic" : ""} text-[13px]`}>{tab.headline}</TabLabel>
            </span>
          </span>
        </button>
        {onClose ? (
          <button
            type="button"
            title="关闭标签"
            aria-label={`关闭 ${tab.headline}`}
            data-no-drag
            data-tauri-drag-region="false"
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
    </div>
  );
}

/**
 * MonoCode's title bar for the work area: the active Pi session is the
 * first tab; open files sit beside it and drag to reorder. Empty strip
 * space drags the window. On narrow/no-rail layouts it also carries the
 * traffic-light gutter and the panel toggle.
 */
export function TitleBar({ railsHidden }: { railsHidden: boolean }) {
  const cwd = useWorkspace((state) => state.cwd);
  const sessionFile = useWorkspace((state) => state.state?.sessionFile);
  const running = useWorkspace((state) => state.transcript.running);
  const liveSessions = useWorkspace((state) => state.liveSessions);
  const files = useShell((state) => state.files);
  const activeFile = useShell((state) => state.activeFile);
  const terminalOpen = useShell((state) => state.terminalOpen);
  const focusFile = useShell((state) => state.focusFile);
  const closeFile = useShell((state) => state.closeFile);
  const pinFile = useShell((state) => state.pinFile);
  const reorderTabs = useShell((state) => state.reorderTabs);
  const sessionSlot = useShell((state) => state.sessionSlot);
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

  const fileIds = useMemo(() => files.map((file) => file.path), [files]);
  // One strip, like MonoCode: the session tab and open files share one drag
  // order, so every tab drags as soon as there are two.
  const stripIds = useMemo(() => ["session", ...fileIds], [fileIds]);
  const sortable = useAnimatedReorder(stripIds, (ids) => reorderTabs(ids), "x");
  const canDragTabs = stripIds.length > 1;

  const sessionTab: Tab = { id: "session", kind: "session", headline: sessionTitle, busy: running };
  const fileTab = (file: OpenFile): Tab => ({ id: file.path, kind: "file", headline: file.name, preview: file.preview, fileName: file.name });
  const before = files.slice(0, sessionSlot).map(fileTab);
  const after = files.slice(sessionSlot).map(fileTab);

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
        <div className="relative h-full min-w-0 flex-1 overflow-hidden">
          <div className="scrollbar-none flex h-full min-w-0 cursor-default items-center gap-0.5 overflow-x-auto overflow-y-hidden overscroll-none pl-1.5 pr-2.5" data-tauri-drag-region>
            {before.map((tab) => (
              <TitleTab
                key={tab.id}
                tab={tab}
                active={activeFile === tab.id}
                sortable={sortable}
                canDrag={canDragTabs}
                onSelect={() => focusFile(tab.id)}
                onClose={() => closeFile(tab.id)}
                onPin={() => pinFile(tab.id)}
              />
            ))}
            <TitleTab
              tab={sessionTab}
              active={!activeFile}
              sortable={sortable}
              canDrag={canDragTabs}
              onSelect={() => focusFile(null)}
              onClose={session ? () => { void closeSession(); } : undefined}
            />
            {after.map((tab) => (
              <TitleTab
                key={tab.id}
                tab={tab}
                active={activeFile === tab.id}
                sortable={sortable}
                canDrag={canDragTabs}
                onSelect={() => focusFile(tab.id)}
                onClose={() => closeFile(tab.id)}
                onPin={() => pinFile(tab.id)}
              />
            ))}
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
    </header>
  );
}
