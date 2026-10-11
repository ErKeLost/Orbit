import { useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { activeProjects, derivedProjectColor, sortPinnedFirst, useProjects } from "../../lib/projects";
import { desktopRuntime, report } from "../../lib/rpc";
import { openWorkspaceScope } from "../../lib/workspace-scope";
import { useWorkspace } from "../../lib/store";
import { Folder, FolderPlus, Loader, MessageSquare } from "../../shared/ui/icons";
import { MenuItem, MenuSeparator } from "../../shared/ui/controls";
import { Popover } from "../../shared/ui/Popover";
import { Icon } from "../../components/Icon";

/**
 * 新会话（EmptySession）composer 顶部的范围选择器：当前项目 / 主目录。
 *
 * 只在空会话（还没有任何消息）时出现——会话一旦开始，切范围等于打断它，
 * 入口就随首页一起撤下。菜单列出「不在文件夹里工作」（home 模式）和全部
 * 注册项目；桌面端再附一个「打开文件夹…」直达系统选目录。
 */
export function ProjectPicker({ disabled }: { disabled: boolean }) {
  const cwd = useWorkspace((state) => state.cwd);
  const workspaceMode = useWorkspace((state) => state.workspaceMode);
  const homeDir = useWorkspace((state) => state.homeDir);
  const projects = useProjects((state) => state.projects);
  const anchor = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);

  const list = useMemo(() => sortPinnedFirst(activeProjects(projects)), [projects]);
  const currentName = projects.find((project) => project.path === cwd)?.name
    ?? cwd.split(/[\\/]/).filter(Boolean).at(-1)
    ?? cwd;

  async function pick(path: string, mode: "project" | "home") {
    setMenu(false);
    setBusy(true);
    try {
      await openWorkspaceScope(path, mode);
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  }

  async function addFolder() {
    setMenu(false);
    if (!desktopRuntime()) {
      report("请在电脑端选择文件夹");
      return;
    }
    const selected = await open({ directory: true, multiple: false, title: "打开项目", defaultPath: cwd || undefined });
    if (!selected) return;
    const path = ((Array.isArray(selected) ? selected[0] : selected) as string).replace(/\/+$/, "") || "/";
    useProjects.getState().add([path]);
    await pick(path, "project");
  }

  return (
    <>
      <button
        ref={anchor}
        type="button"
        disabled={disabled || busy}
        title={workspaceMode === "home" ? "当前在主目录对话，点击切换" : "当前项目，点击切换"}
        aria-haspopup="menu"
        aria-expanded={menu}
        onClick={() => setMenu((value) => !value)}
        className="-ml-1.5 flex h-6 min-w-0 shrink items-center gap-1.5 rounded-md px-1.5 text-[12px] text-content/55 hover:bg-content/8 hover:text-content disabled:cursor-default disabled:opacity-40"
      >
        {busy ? (
          <Loader className="size-3.5 shrink-0 animate-spin" />
        ) : (
          <Folder className="size-3.5 shrink-0" strokeWidth={1.75} />
        )}
        <span className="min-w-0 truncate">{workspaceMode === "home" ? "主目录" : currentName}</span>
      </button>
      {menu ? (
        <Popover anchor={anchor} align="start" width={240} onDismiss={() => setMenu(false)} role="menu" aria-label="选择工作范围" className="max-h-80 overflow-y-auto p-1">
          {homeDir ? (
            <MenuItem icon={<MessageSquare strokeWidth={1.75} />} onClick={() => void pick(homeDir, "home")}>
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="min-w-0 flex-1 truncate">不在文件夹里工作</span>
                {workspaceMode === "home" ? <Icon name="check" className="size-3.5 shrink-0 text-accent" /> : null}
              </span>
            </MenuItem>
          ) : null}
          {homeDir && list.length ? <MenuSeparator /> : null}
          {list.map((project) => (
            <MenuItem
              key={project.path}
              icon={
                <span className="grid size-4 shrink-0 place-items-center" style={{ color: derivedProjectColor(project.path) }}>
                  <Folder className="size-3.5 opacity-70" strokeWidth={1.75} />
                </span>
              }
              onClick={() => void pick(project.path, "project")}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="min-w-0 flex-1 truncate" title={project.path}>{project.name}</span>
                {workspaceMode === "project" && project.path === cwd ? <Icon name="check" className="size-3.5 shrink-0 text-accent" /> : null}
              </span>
            </MenuItem>
          ))}
          {desktopRuntime() ? (
            <>
              <MenuSeparator />
              <MenuItem icon={<FolderPlus strokeWidth={1.75} />} onClick={() => void addFolder().catch(report)}>
                打开文件夹…
              </MenuItem>
            </>
          ) : null}
        </Popover>
      ) : null}
    </>
  );
}
