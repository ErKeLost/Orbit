import { useMemo } from "react";
import { useWorkspace } from "../../lib/store";
import { mergeProjectSessions, useProjectSessions } from "../../hooks/use-project-sessions";
import { compactTitle } from "../../lib/session-visual";
import { TabLabel } from "../../shared/ui/TabLabel";
import { PanelLeft, Settings, Terminal, X } from "../../shared/ui/icons";
import { FileTypeIcon } from "./FileTypeIcon";
import { IS_MAC, MOD, TitleIconButton } from "./chrome";
import { TerminalSpinner } from "./TerminalSpinner";
import { useShell } from "./shellStore";

type Tab = { id: string; kind: "session" | "file"; headline: string; meta?: string; busy?: boolean; preview?: boolean; fileName?: string };

function TitleTab({ tab, active, onSelect, onClose }: { tab: Tab; active: boolean; onSelect: () => void; onClose?: () => void }) {
  return (
    <div className="relative flex h-full w-56 min-w-28 shrink cursor-default items-center" data-tauri-drag-region="false">
      <div className="tab-motion group @container relative flex h-full min-w-0 w-full cursor-default items-center self-stretch" data-tauri-drag-region="false">
        <button
          type="button"
          title={tab.meta ? `${tab.headline}\n${tab.meta}` : tab.headline}
          aria-label={tab.headline}
          data-tauri-drag-region="false"
          onClick={onSelect}
          onDoubleClick={() => {
            if (tab.kind === "file" && tab.preview) useShell.getState().pinFile(tab.id);
          }}
          className={`relative flex h-7.5 min-w-0 flex-1 cursor-default items-center gap-1.5 self-center rounded-md px-2 text-left ${onClose ? "pr-7" : "pr-2.5"} ${
            active ? "bg-selection text-content" : "text-content/50 hover:bg-content/5 hover:text-content"
          }`}
        >
          {tab.kind === "session" ? (
            tab.busy ? <TerminalSpinner className="inline-block w-3.5 select-none text-center text-[11px] leading-none text-accent" /> : null
          ) : (
            <span className={!active ? "opacity-55" : undefined}>
              <FileTypeIcon name={tab.fileName ?? tab.headline} isDir={false} size={14} />
            </span>
          )}
          <span className="flex min-w-0 flex-1 flex-col justify-center">
            <span className="flex min-w-0 items-center gap-1">
              <TabLabel className={`leading-tight ${tab.preview ? "italic" : ""} ${tab.meta ? "text-[13px] @min-[11rem]:text-[10px] @min-[11rem]:font-medium" : "text-[13px]"}`}>{tab.headline}</TabLabel>
            </span>
            {tab.meta ? <TabLabel className="hidden text-[10px] leading-tight text-content/45 @min-[11rem]:block">{tab.meta}</TabLabel> : null}
          </span>
        </button>
        {onClose ? (
          <button
            type="button"
            title="关闭标签"
            aria-label={`关闭 ${tab.headline}`}
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
 * first tab; open files sit beside it. On narrow/no-rail layouts it also
 * carries the traffic-light gutter and the panel toggle.
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
  const sessions = useProjectSessions(cwd);
  const merged = useMemo(() => mergeProjectSessions(cwd, sessions.data ?? [], liveSessions), [cwd, sessions.data, liveSessions]);
  const session = merged.sessions.find((item) => item.path === sessionFile);
  const sessionTitle = compactTitle(session?.name || session?.firstMessage, "新会话", 60);

  const tabs: Tab[] = [
    { id: "session", kind: "session", headline: sessionTitle, busy: running },
    ...files.map((file): Tab => ({ id: file.path, kind: "file", headline: file.name, meta: undefined, preview: file.preview, fileName: file.name })),
  ];
  // With a file beside the chat, the session tab reads "file · chat" like MonoCode's split tab.
  if (files.length && activeFile) {
    const file = files.find((item) => item.path === activeFile);
    if (file) tabs[0] = { ...tabs[0], headline: file.name, meta: sessionTitle, fileName: file.name, kind: "session" };
  }

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
            <TitleTab tab={tabs[0]} active onSelect={() => focusFile(activeFile)} />
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
      {files.length > 1 ? (
        <div className="hidden">{files.map((file) => <button key={file.path} type="button" onClick={() => closeFile(file.path)} />)}</div>
      ) : null}
    </header>
  );
}
