import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "../../lib/store";
import { changeSession, connect, report } from "../../lib/rpc";
import { useProjects } from "../../lib/projects";
import { MIN_QUERY, useFileSearch } from "../../lib/search";
import { useShell } from "../shell/shellStore";
import { FileTypeIcon } from "../shell/FileTypeIcon";
import {
  FolderTree,
  Inbox as InboxIcon,
  File,
  Loader,
  MessageSquare,
  PanelLeft,
  Plus,
  Search as SearchIcon,
  Settings,
  SmartPhone,
  Terminal,
  Zap,
  type IconComponent,
} from "../../shared/ui/icons";

/**
 * monocode 的 ⌘P「转到文件」浮层：顶部居中的下拉，输入文件名模糊过滤，
 * 输入 `>` 进入命令模式。Orbit 的命令集取自它自己的面板与会话动作。
 */

type Command = { id: string; label: string; icon: IconComponent; run: () => void };

function useCommands(): Command[] {
  const setPanel = (panel: Parameters<ReturnType<typeof useWorkspace.getState>["set"]>[0]["panel"]) =>
    useWorkspace.getState().set({ panel });
  return useMemo(
    () => [
      { id: "cmd:new-session", label: "新会话", icon: Plus, run: () => void changeSession({ type: "new_session" }).catch(report) },
      { id: "cmd:inbox", label: "打开收件箱", icon: InboxIcon, run: () => setPanel("inbox") },
      { id: "cmd:notes", label: "打开笔记", icon: File, run: () => setPanel("notes") },
      { id: "cmd:automations", label: "打开自动化", icon: Zap, run: () => setPanel("automations") },
      { id: "cmd:mobile", label: "打开移动端", icon: SmartPhone, run: () => setPanel("mobile-access") },
      { id: "cmd:settings", label: "打开设置", icon: Settings, run: () => useWorkspace.getState().set({ panel: "settings", settingsPage: "general" }) },
      { id: "cmd:project-rail", label: "切换项目栏", icon: PanelLeft, run: () => useShell.getState().setProjectRailOpen(!useShell.getState().projectRailOpen) },
      { id: "cmd:sidebar", label: "切换侧栏", icon: MessageSquare, run: () => useShell.getState().setSessionSidebarOpen(!useShell.getState().sessionSidebarOpen) },
      { id: "cmd:files", label: "打开文件树", icon: FolderTree, run: () => { useShell.getState().setSessionSidebarOpen(true); useShell.getState().setSidebarTab("files"); } },
      { id: "cmd:changes", label: "打开变更", icon: MessageSquare, run: () => { useShell.getState().setSessionSidebarOpen(true); useShell.getState().setSidebarTab("changes"); } },
      { id: "cmd:terminal", label: "切换终端", icon: Terminal, run: () => useShell.getState().setTerminalOpen(!useShell.getState().terminalOpen) },
    ],
    [],
  );
}

export function QuickOpen() {
  const open = useShell((state) => state.quickOpen);
  const setOpen = useShell((state) => state.setQuickOpen);
  return open ? <QuickOpenOverlay onClose={() => setOpen(false)} /> : null;
}

function QuickOpenOverlay({ onClose }: { onClose: () => void }) {
  const cwd = useWorkspace((state) => state.cwd);
  const homeDir = useWorkspace((state) => state.homeDir);
  const workspaceMode = useWorkspace((state) => state.workspaceMode);
  const { projects } = useProjects();
  const commands = useCommands();
  const [raw, setRaw] = useState("");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(raw.trim()), 140);
    return () => window.clearTimeout(timer);
  }, [raw]);

  const commandMode = raw.startsWith(">");
  const project = workspaceMode === "project" && cwd && cwd !== homeDir ? cwd : "";
  const files = useFileSearch(project, commandMode ? "" : query, Boolean(project));
  const fileHits = useMemo(() => (files.data ?? []).slice(0, 12), [files.data]);

  const matchedCommands = useMemo(() => {
    if (!commandMode) return [];
    const needle = raw.slice(1).trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((command) => command.label.toLowerCase().includes(needle));
  }, [commandMode, commands, raw]);

  const matchedProjects = useMemo(() => {
    if (commandMode || query.length < MIN_QUERY) return [];
    const needle = query.toLowerCase();
    return projects.filter((item) => `${item.name} ${item.path}`.toLowerCase().includes(needle)).slice(0, 4);
  }, [projects, query, commandMode]);

  type Row =
    | { kind: "file"; key: string; label: string; path: string; relative: string; line: number | null }
    | { kind: "command"; key: string; label: string; icon: IconComponent; run: () => void }
    | { kind: "project"; key: string; label: string; path: string };

  const rows = useMemo<Row[]>(() => {
    if (commandMode) {
      return matchedCommands.map((command) => ({ kind: "command" as const, key: command.id, label: command.label, icon: command.icon, run: command.run }));
    }
    return [
      ...fileHits.map((hit) => ({ kind: "file" as const, key: `${hit.path}:${hit.line ?? 0}`, label: hit.relative, path: hit.path, relative: hit.relative, line: hit.line })),
      ...matchedProjects.map((item) => ({ kind: "project" as const, key: item.path, label: item.name, path: item.path })),
    ];
  }, [commandMode, matchedCommands, fileHits, matchedProjects]);

  useEffect(() => {
    setActive(0);
  }, [raw]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>("[data-active='true']")?.scrollIntoView({ block: "nearest" });
  }, [active, rows.length]);

  const pick = (row: Row) => {
    onClose();
    if (row.kind === "file") {
      useWorkspace.getState().set({ panel: "chat" });
      useShell.getState().openFile(row.path, { pin: true });
    } else if (row.kind === "command") {
      row.run();
    } else {
      useWorkspace.getState().set({ panel: "chat" });
      void connect(row.path, "project").catch(report);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="转到文件"
      className="fixed inset-0 z-[80]"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActive((value) => Math.min(rows.length - 1, value + 1));
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setActive((value) => Math.max(0, value - 1));
        }
        if (event.key === "Enter") {
          event.preventDefault();
          const row = rows[active];
          if (row) pick(row);
        }
      }}
    >
      <div className="mx-auto mt-2 w-[min(640px,92vw)] overflow-hidden rounded-xl border border-content/10 bg-background-base/95 shadow-2xl backdrop-blur-xl">
        <label className="flex h-11 items-center gap-2 border-b border-stroke px-3 text-content/50">
          <SearchIcon className="size-4 shrink-0" strokeWidth={1.75} />
          <input
            ref={input}
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
            placeholder={commandMode ? "输入命令…" : "转到文件（输入 > 执行命令）"}
            aria-label="转到文件或执行命令"
            className="min-w-0 flex-1 select-text bg-transparent text-[13px] text-content outline-none placeholder:text-content/40"
          />
          {files.isFetching ? <Loader className="size-3.5 shrink-0 animate-spin text-content/35" /> : null}
        </label>
        <div ref={listRef} className="max-h-[420px] overflow-y-auto overscroll-none p-1.5">
          {rows.length === 0 ? (
            <p className="px-2.5 py-3 text-[12px] text-content/45">{commandMode ? "没有匹配的命令" : query.length >= MIN_QUERY ? "没有匹配的文件" : "输入文件名，或 > 执行命令"}</p>
          ) : (
            rows.map((row, index) => {
              const isActive = index === active;
              return (
                <button
                  key={row.key}
                  type="button"
                  data-active={isActive}
                  aria-selected={isActive}
                  role="option"
                  onMouseMove={() => setActive(index)}
                  onClick={() => pick(row)}
                  className={`flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] leading-none ${
                    isActive ? "bg-selection text-content" : "text-content/80 hover:bg-content/5"
                  }`}
                >
                  <span className="grid size-4 shrink-0 place-items-center text-content/50">
                    {row.kind === "file" ? (
                      <FileTypeIcon name={row.relative.split("/").at(-1) ?? row.relative} isDir={false} size={14} />
                    ) : row.kind === "command" ? (
                      <row.icon className="size-3.5" strokeWidth={1.75} />
                    ) : (
                      <SearchIcon className="size-3.5" strokeWidth={1.75} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{row.kind === "file" ? row.relative : row.label}</span>
                  {row.kind === "file" && row.line ? <span className="shrink-0 font-mono text-[11px] text-content/40">:{row.line}</span> : null}
                  {row.kind === "project" ? <span className="min-w-0 max-w-[45%] shrink-0 truncate font-mono text-[11px] text-content/40">{row.path}</span> : null}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
