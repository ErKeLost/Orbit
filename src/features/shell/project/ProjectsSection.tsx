import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  derivedProjectColor,
  projectColor,
  projectRoots,
  type Project,
} from "../../../lib/projects";
import { useAnimatedReorder } from "../../../shared/hooks/useAnimatedReorder";
import { Popover } from "../../../shared/ui/Popover";
import { MenuItem } from "../../../shared/ui/controls";
import { Folder, FolderOpen, FolderPlus, MessageSquare, MoreHorizontal, Plus } from "../../../shared/ui/icons";
import { TerminalSpinner } from "../TerminalSpinner";

/**
 * 侧栏的「项目」段：一列可以点着切过去的项目。
 *
 * 标题上的 `ProjectSwitcher` 回答「我在哪」，这一列回答「我还能去哪」——两者
 * 并存是有意的：一行横幅装不下十几个项目，而每次切项目都先点标题、再进子菜单
 * 也太绕。行内还能拖动排序、右键改名字 / Logo / 目录。
 */

/** 分段标题：右边是项目数量，再右边是「打开项目」的加号菜单。 */
function SectionHeader({
  label,
  count,
  onAdd,
  extraItem,
}: {
  label: string;
  count: number;
  onAdd?: () => void;
  extraItem?: { label: string; icon: ReactNode; onClick: () => void };
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  return (
    <div className="flex h-7 items-center gap-1 px-3 pb-1.5 pt-1">
      <span className="min-w-0 flex-1 truncate px-0.5 text-xs leading-5 text-content/50">{label}</span>
      <span className="shrink-0 rounded-full bg-content/8 px-1.5 text-[10px] tabular-nums leading-4 text-content/50">{count}</span>
      {onAdd ? (
        <>
          <button
            ref={anchor}
            type="button"
            title="打开项目"
            aria-label="打开项目"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((value) => !value)}
            className="grid size-5 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/8 hover:text-content aria-expanded:bg-content/8 aria-expanded:text-content"
          >
            <Plus className="size-3.5" strokeWidth={1.75} />
          </button>
          {menu ? (
            <Popover anchor={anchor} align="start" width={230} onDismiss={() => setMenu(false)} role="menu" aria-label="打开项目" className="p-1">
              <MenuItem icon={<FolderPlus strokeWidth={1.75} />} onClick={() => { setMenu(false); onAdd(); }}>
                打开文件夹…
              </MenuItem>
              {extraItem ? (
                <MenuItem icon={extraItem.icon} onClick={() => { setMenu(false); extraItem.onClick(); }}>
                  {extraItem.label}
                </MenuItem>
              ) : null}
            </Popover>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

type SortableApi = ReturnType<typeof useAnimatedReorder>;

/**
 * 项目段里的一行：点一下切过去，右键改名字 / Logo / roots，按住拖动排序。
 *
 * 一个项目可能有多个 root，行尾的角标只报个数，全部路径放在 title 里——行高只有
 * 28px，塞不下第二条路径，硬塞就是把名字也挤断。
 */
function ProjectRow({
  project,
  selected,
  busy,
  canDrag,
  sortable,
  onSelect,
  onOpenMenu,
}: {
  project: Project;
  selected: boolean;
  busy: boolean;
  canDrag: boolean;
  sortable: SortableApi;
  onSelect: (path: string) => void;
  onOpenMenu: (project: Project, x: number, y: number) => void;
}) {
  const roots = projectRoots(project);
  const color = projectColor(project) ?? derivedProjectColor(project.path);
  const title = roots.length > 1 ? `${project.name}\n${roots.join("\n")}` : `${project.name}\n${project.path}`;
  return (
    <div
      ref={(node) => sortable.setItemRef(project.path, node)}
      data-selected={selected || undefined}
      data-project-row={project.path}
      data-project-roots={roots.length}
      className={`reorder-item group relative flex h-7 cursor-default touch-none select-none items-center rounded-md ${
        selected ? "bg-selection-strong text-content" : "text-content/75 hover:bg-content/5 hover:text-content"
      }`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        if ((event.target as HTMLElement | null)?.closest("[data-no-drag]")) return;
        if (canDrag) sortable.onItemPointerDown(project.path, event);
      }}
      onClick={(event) => {
        if ((event.target as HTMLElement | null)?.closest("[data-no-drag]")) return;
        if (sortable.consumeClick()) return;
        onSelect(project.path);
      }}
      onContextMenu={(event: ReactMouseEvent) => {
        event.preventDefault();
        onOpenMenu(project, event.clientX, event.clientY);
      }}
    >
      <button
        type="button"
        title={title}
        aria-label={project.name}
        aria-current={selected ? "true" : undefined}
        className="flex h-full min-w-0 flex-1 cursor-default items-center gap-2 pl-1.5 pr-7 text-left"
      >
        {/* Logo 优先，否则文件夹（选中 = 打开态），颜色按项目派生。 */}
        {project.logoPath ? (
          <img src={convertFileSrc(project.logoPath)} alt="" className="size-4 shrink-0 rounded object-cover" />
        ) : (
          <span className="shrink-0" style={{ color }}>
            {selected ? (
              <FolderOpen className="size-4 opacity-70" strokeWidth={1.75} aria-hidden />
            ) : (
              <Folder className="size-4 opacity-70" strokeWidth={1.75} aria-hidden />
            )}
          </span>
        )}
        <span className={`min-w-0 flex-1 truncate text-[12.5px] leading-tight ${selected ? "font-medium" : ""}`}>{project.name}</span>
        {roots.length > 1 ? (
          <span
            title={roots.join("\n")}
            className="shrink-0 rounded bg-content/8 px-1 text-[10px] tabular-nums leading-4 text-content/45 group-hover:hidden"
          >
            {roots.length}
          </span>
        ) : null}
        {busy ? <TerminalSpinner className="shrink-0 text-[11px] leading-none text-accent group-hover:hidden" /> : null}
      </button>
      <button
        type="button"
        data-no-drag
        title="项目选项"
        aria-label={`${project.name} 项目选项`}
        aria-haspopup="menu"
        onClick={(event) => {
          event.stopPropagation();
          onOpenMenu(project, event.clientX, event.clientY);
        }}
        className="absolute right-1 top-1/2 hidden size-5 -translate-y-1/2 place-items-center rounded-md text-content/55 hover:bg-content/10 hover:text-content group-hover:grid group-data-[selected]:grid"
      >
        <MoreHorizontal className="size-4" strokeWidth={1.75} />
      </button>
    </div>
  );
}

export function ProjectsSection({
  projects,
  currentPath,
  busyPath,
  runningPaths = [],
  onSelect,
  onOpenMenu,
  onReorder,
  onAdd,
  onHome,
}: {
  /** 已注册、未归档、已按置顶排好序的项目。 */
  projects: Project[];
  /** 当前项目；首页（不在任何项目里）时不给，于是没有一行是选中的。 */
  currentPath?: string;
  /** 正在切过去的那个项目：行尾转圈。 */
  busyPath?: string;
  /** 有会话正在跑的项目：同样转圈，切走之前就知道它还活着。 */
  runningPaths?: string[];
  onSelect: (path: string) => void;
  onOpenMenu: (project: Project, x: number, y: number) => void;
  onReorder: (paths: string[]) => void;
  onAdd?: () => void;
  onHome?: () => void;
}) {
  const paths = useMemo(() => projects.map((project) => project.path), [projects]);
  const sortable = useAnimatedReorder(paths, (ids) => onReorder(ids), "y");
  const running = useMemo(() => new Set(runningPaths), [runningPaths]);
  return (
    <section aria-label="项目" className="mb-2 shrink-0">
      <SectionHeader
        label="项目"
        count={projects.length}
        onAdd={onAdd}
        extraItem={onHome ? { label: "不在文件夹里工作", icon: <MessageSquare strokeWidth={1.75} />, onClick: onHome } : undefined}
      />
      {projects.length === 0 ? (
        <p className="px-4 pb-1 text-[11px] leading-tight text-content/40">还没有项目</p>
      ) : null}
      <div role="list" aria-label="项目列表" className="flex flex-col gap-px px-2">
        {projects.map((project) => (
          <ProjectRow
            key={project.path}
            project={project}
            selected={Boolean(currentPath) && project.path === currentPath}
            busy={busyPath === project.path || running.has(project.path)}
            canDrag={projects.length > 1}
            sortable={sortable}
            onSelect={onSelect}
            onOpenMenu={onOpenMenu}
          />
        ))}
      </div>
    </section>
  );
}
