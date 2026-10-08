import { useWorkspace } from "../../lib/store";
import { PanelLeft, Settings, Terminal } from "../../shared/ui/icons";
import { IS_MAC, MOD, TitleIconButton } from "./chrome";
import { useShell } from "./shellStore";

/**
 * MonoCode's window title bar (`app/shell/TitleBar.tsx`): the workspace title,
 * the settings search and the title-bar actions. It holds **no tabs** — MonoCode
 * keeps every tab inside its own pane (`SurfaceTabs`), and the session's own
 * header lives in the session pane (`PaneChrome.SessionPaneHeader`).
 */
export function TitleBar({ railsHidden }: { railsHidden: boolean }) {
  const terminalOpen = useShell((state) => state.terminalOpen);

  return (
    <header className="flex h-10 shrink-0 select-none items-stretch border-b border-stroke" data-tauri-drag-region>
      {railsHidden ? (
        <>
          {IS_MAC ? <div className="w-[78px] shrink-0" /> : null}
          <div className="flex shrink-0 items-center px-1.5">
            <TitleIconButton
              label={`切换侧栏 (${MOD}B)`}
              onClick={() => {
                useShell.getState().setProjectRailOpen(true);
                useShell.getState().setSessionSidebarOpen(true);
              }}
            >
              <PanelLeft className="size-3.5" strokeWidth={1.75} />
            </TitleIconButton>
          </div>
        </>
      ) : null}
      <div className="flex min-w-0 flex-1 items-center px-2">
        <span className="truncate text-[13px] text-content/45">工作区</span>
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
          <TitleIconButton
            label={`设置 (${MOD},)`}
            onClick={() => useWorkspace.getState().set({ panel: "settings", settingsPage: "general" })}
          >
            <Settings className="size-3.5" strokeWidth={1.75} />
          </TitleIconButton>
        ) : null}
      </div>
    </header>
  );
}
