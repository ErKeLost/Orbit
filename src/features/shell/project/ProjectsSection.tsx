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
 * 侧栏的「项目」段：一列可以点着切过去的项目，也是切项目的唯一入口
 * （顶部曾经还有一行项目标题菜单，现在已去掉）。
 *
 * 行内还能拖动排序、右键改名字 / Logo / 目录 / 归档。
 */

/** 分段标题：只有名字和「打开项目」的加号菜单，右侧不再挂数量。 */
function SectionHeader({
  label,
  onAdd,
  extraItem,
}: {
  label: string;
  onAdd?: () => void;
  extraItem?: { label: string; icon: ReactNode; onClick: () => void };
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  return (
    <div className="flex h-8 items-center gap-1 px-3 pb-1 pt-3">
      <span className="min-w-0 flex-1 truncate px-0.5 text-2xs leading-5 text-ink-3">{label}</span>
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
            className="grid size-5 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-fill-strong hover:text-ink-1 aria-expanded:bg-fill-strong aria-expanded:text-ink-1"
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
 * No projects yet: one dashed tile holding a folder-plus, no sentence.
 *
 * The label was noise — a rail that says "还没有项目" in text is asking the
 * reader to interpret instead of act. The icon is the action itself when a
 * picker is available, and a quiet placeholder when it is not (a phone, where
 * the picker lives on the desktop).
 */
function EmptyProjects({ onAdd }: { onAdd?: () => void }) {
  const className =
    "ml-1.5 grid size-8 place-items-center rounded-control border border-dashed border-line-strong text-ink-3";
  if (!onAdd) {
    return (
      <div className="px-2 pb-2">
        <div className={className} aria-hidden>
          <FolderPlus className="size-4" strokeWidth={1.75} />
        </div>
      </div>
    );
  }
  return (
    <div className="px-2 pb-2">
      <button
        type="button"
        title="打开文件夹"
        aria-label="打开文件夹"
        onClick={onAdd}
        className={`${className} hover:border-accent/50 hover:bg-fill hover:text-ink-1`}
      >
        <FolderPlus className="size-4" strokeWidth={1.75} />
      </button>
    </div>
  );
}

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
      className={`reorder-item group relative flex h-8 cursor-default touch-none select-none items-center rounded-control ${
        selected ? "bg-selection-strong text-ink-1" : "text-ink-2 hover:bg-fill hover:text-ink-1"
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
        <span className={`min-w-0 flex-1 truncate text-ui leading-tight ${selected ? "font-medium" : ""}`}>{project.name}</span>
        {busy ? <TerminalSpinner className="shrink-0 text-2xs leading-none text-accent group-hover:hidden" /> : null}
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
        className="absolute right-1 top-1/2 hidden size-5 -translate-y-1/2 place-items-center rounded-md text-ink-2 hover:bg-fill-strong hover:text-ink-1 group-hover:grid group-data-[selected]:grid"
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
        onAdd={onAdd}
        extraItem={onHome ? { label: "不在文件夹里工作", icon: <MessageSquare strokeWidth={1.75} />, onClick: onHome } : undefined}
      />
      {projects.length === 0 ? <EmptyProjects onAdd={onAdd} /> : null}
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
