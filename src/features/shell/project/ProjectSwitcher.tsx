import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useQueryClient } from "@tanstack/react-query";
import { derivedProjectColor, projectColor, type Project } from "../../../lib/projects";
import { gitCheckout, gitCreateBranch, useGitBranches } from "../../../lib/git";
import { report } from "../../../lib/rpc";
import { LAYER } from "../../../shared/lib/layers";
import { parentPath, prettyCwd } from "../../../shared/lib/paths";
import { Popover } from "../../../shared/ui/Popover";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  GitBranch,
  Loader,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
} from "../../../shared/ui/icons";

/**
 * 侧栏标题上的项目切换器（monocode 的 `SidebarWorktreeSwitcher`）。
 *
 * 标题只负责「现在在哪个项目 / 哪条分支」，切换本身下沉成菜单里的子级：
 * 分支 → 项目 → 项目设置 → 设置。这样侧栏顶部只有一行，项目列表和分支列表
 * 都不再常驻占位置，但都还是一次点击的距离。
 *
 * 菜单和它的浮层共享 `PROJECT_MENU` 标记：点进浮层不算点到外面。
 */
const PROJECT_MENU = "[data-project-menu]";

type Flyout = "none" | "branch" | "project";

export function ProjectSwitcher({
  current,
  projects,
  pending = false,
  onSelectProject,
  onAddProject,
  onOpenHome,
  onOpenProjectMenu,
  onOpenSettings,
  settingsShortcut,
}: {
  /** 当前工作区所属项目；在首页（不属于任何项目）时为 null。 */
  current: Project | null;
  /** 已注册、未归档的项目，按固定顺序。 */
  projects: Project[];
  pending?: boolean;
  onSelectProject: (path: string) => void;
  onAddProject?: () => void;
  /** 「不在文件夹里工作」：项目模式下没有项目，会话挂在主目录上。 */
  onOpenHome?: () => void;
  /** 打开项目的右键菜单（改名 / Logo / 置顶 / 移除）。 */
  onOpenProjectMenu: (project: Project, x: number, y: number) => void;
  onOpenSettings: () => void;
  settingsShortcut?: string;
}) {
  const [open, setOpen] = useState(false);
  const [flyout, setFlyout] = useState<Flyout>("none");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [branchBusy, setBranchBusy] = useState("");
  const anchor = useRef<HTMLButtonElement>(null);
  const branchRow = useRef<HTMLButtonElement>(null);
  const projectRow = useRef<HTMLButtonElement>(null);
  const settingsRow = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  /** 展开过浮层的那一行，浮层关掉后焦点要回到它，而不是菜单第一行。 */
  const opener = useRef<HTMLButtonElement | null>(null);
  const queryClient = useQueryClient();

  const branches = useGitBranches(current?.path, open && Boolean(current));
  const branchList = branches.data?.branches ?? [];
  const currentBranch = branches.data?.detached
    ? "detached"
    : (branches.data?.current ?? null);

  const close = () => {
    setOpen(false);
    setFlyout("none");
    setQuery("");
    setActive(0);
  };

  const closeFlyout = () => {
    setFlyout("none");
    setQuery("");
    setActive(0);
  };

  const refreshGit = () => {
    void queryClient.invalidateQueries({ queryKey: ["git", "branches"] });
    void queryClient.invalidateQueries({ queryKey: ["git", "diff-stats"] });
    void queryClient.invalidateQueries({ queryKey: ["git", "changed-files"] });
  };

  const pickProject = (path: string) => {
    close();
    onSelectProject(path);
  };

  async function pickBranch(name: string) {
    if (!current || branchBusy) return;
    if (name === currentBranch) {
      closeFlyout();
      return;
    }
    setBranchBusy(name);
    try {
      await gitCheckout(current.path, name);
      refreshGit();
      close();
    } catch (error) {
      report(error);
    } finally {
      setBranchBusy("");
    }
  }

  async function createBranch() {
    const name = query.trim();
    if (!current || !name || branchBusy) return;
    setBranchBusy(name);
    try {
      await gitCreateBranch(current.path, name);
      refreshGit();
      close();
    } catch (error) {
      report(error);
    } finally {
      setBranchBusy("");
    }
  }

  /** 分支和项目两个浮层共用的搜索条件。 */
  const branchRows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return branchList;
    return branchList.filter((branch) => branch.name.toLocaleLowerCase().includes(needle));
  }, [branchList, query]);

  const projectRows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return projects;
    return projects.filter(
      (project) =>
        project.name.toLocaleLowerCase().includes(needle) ||
        project.path.toLocaleLowerCase().includes(needle),
    );
  }, [projects, query]);

  const branchCreateName = query.trim();
  const canCreateBranch =
    Boolean(current) &&
    branchCreateName.length > 0 &&
    !branchList.some((branch) => branch.name === branchCreateName);

  // 浮层打开时把焦点交给搜索框，和菜单里一路 ArrowRight 过来的手感一致；
  // 关掉后回到展开它的那一行，方向键不会从菜单开头重新数。
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      if (flyout !== "none") {
        search.current?.focus({ preventScroll: true });
        return;
      }
      const back = opener.current?.isConnected
        ? opener.current
        : surface.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]');
      back?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [flyout, open]);

  /** 子级浮层由对应的那一行展开，并记住它。 */
  const openFlyout = (next: Flyout, row: HTMLButtonElement | null) => {
    opener.current = row;
    setFlyout(next);
  };

  /** 菜单内上下移动，Enter 进入，ArrowRight 展开子级。 */
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = index === -1 ? 0 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  /** 浮层内的方向键在「搜索框 → 列表」之间走，Enter 选中。 */
  const onFlyoutKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const rows = flyout === "branch" ? branchRows : projectRows;
      const count = rows.length + (flyout === "branch" && canCreateBranch ? 1 : 0);
      if (count === 0) return;
      event.preventDefault();
      setActive((index) => Math.max(0, Math.min(count - 1, index + (event.key === "ArrowDown" ? 1 : -1))));
      return;
    }
    if (event.key !== "Enter") return;
    if (flyout === "branch") {
      const branch = branchRows[active];
      if (branch) {
        event.preventDefault();
        void pickBranch(branch.name);
      } else if (canCreateBranch) {
        event.preventDefault();
        void createBranch();
      }
      return;
    }
    if (flyout === "project") {
      const project = projectRows[active];
      if (project) {
        event.preventDefault();
        pickProject(project.path);
      }
    }
  };

  const triggerLabel = current?.name ?? "选择项目";
  const branchLabel = currentBranch ?? (current ? "未跟踪的分支" : "");

  return (
    <>
      <button
        ref={anchor}
        type="button"
        data-tauri-drag-region="false"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={pending}
        aria-label={current ? `切换项目，当前 ${current.name}` : "选择项目"}
        title={current ? `${current.name}\n${current.path}` : "选择项目"}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(event) => {
          if (open || (event.key !== "ArrowDown" && event.key !== "Enter")) return;
          event.preventDefault();
          setOpen(true);
        }}
        className="rail-row rail-project-row flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[13px] font-semibold leading-tight hover:bg-content/8 focus-visible:bg-content/8 aria-expanded:bg-content/8"
      >
        {current ? (
          <ProjectMark project={current} />
        ) : (
          <Folder className="size-4 shrink-0 text-content/55" strokeWidth={1.75} aria-hidden />
        )}
        <span className="min-w-0 truncate">{triggerLabel}</span>
        {current ? (
          <span className="min-w-0 shrink-[2] truncate font-normal text-content/45">{branchLabel}</span>
        ) : null}
        {pending ? (
          <Loader className="size-3.5 shrink-0 animate-spin text-content/45" />
        ) : (
          <ChevronDown className="size-3.5 shrink-0 text-content/45" strokeWidth={1.75} />
        )}
      </button>

      {open ? (
        <Popover
          ref={surface}
          anchor={anchor}
          side="bottom"
          align="start"
          width={240}
          constrainHeight={false}
          autoFocus
          ignore={PROJECT_MENU}
          onDismiss={close}
          role="menu"
          aria-label={current ? `${current.name} 菜单` : "项目菜单"}
          data-project-menu
          className="flex flex-col p-1"
          onKeyDown={onMenuKeyDown}
        >
          {current ? (
            <button
              ref={branchRow}
              type="button"
              role="menuitem"
              aria-haspopup="dialog"
              aria-expanded={flyout === "branch"}
              title={currentBranch ?? "切换分支"}
              onClick={(event) => openFlyout("branch", event.currentTarget)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowRight") return;
                event.preventDefault();
                openFlyout("branch", event.currentTarget);
              }}
              className={`flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] hover:bg-content/8 focus-visible:bg-content/8 ${
                flyout === "branch" ? "bg-content/8" : ""
              }`}
            >
              <GitBranch className="size-4 shrink-0 text-content/55" strokeWidth={1.75} />
              <span className="min-w-0 flex-1 truncate">切换分支</span>
              <span className="min-w-0 max-w-24 shrink truncate text-[11px] text-content/40">{branchLabel}</span>
              <ChevronRight className="size-3.5 shrink-0 text-content/40" strokeWidth={1.75} />
            </button>
          ) : null}

          <button
            ref={projectRow}
            type="button"
            role="menuitem"
            aria-haspopup="dialog"
            aria-expanded={flyout === "project"}
            onClick={(event) => openFlyout("project", event.currentTarget)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight") return;
              event.preventDefault();
              openFlyout("project", event.currentTarget);
            }}
            className={`flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] hover:bg-content/8 focus-visible:bg-content/8 ${
              flyout === "project" ? "bg-content/8" : ""
            }`}
          >
            <Folder className="size-4 shrink-0 text-content/55" strokeWidth={1.75} />
            <span className="min-w-0 flex-1 truncate">切换项目</span>
            <ChevronRight className="size-3.5 shrink-0 text-content/40" strokeWidth={1.75} />
          </button>

          {current ? (
            <button
              ref={settingsRow}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              onClick={() => {
                const rect = settingsRow.current?.getBoundingClientRect();
                close();
                if (rect) onOpenProjectMenu(current, rect.left, rect.bottom - 4);
              }}
              className="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] hover:bg-content/8 focus-visible:bg-content/8"
            >
              <SlidersHorizontal className="size-4 shrink-0 text-content/55" strokeWidth={1.75} />
              <span className="min-w-0 flex-1 truncate">项目设置</span>
              <ChevronRight className="size-3.5 shrink-0 text-content/40" strokeWidth={1.75} />
            </button>
          ) : null}

          <div className="mx-2 my-1 h-px bg-stroke" />

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              onOpenSettings();
            }}
            className="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] hover:bg-content/8 focus-visible:bg-content/8"
          >
            <Settings className="size-4 shrink-0 text-content/55" strokeWidth={1.75} />
            <span className="min-w-0 flex-1 truncate">设置</span>
            {settingsShortcut ? (
              <span className="shrink-0 text-[11px] text-content/40">{settingsShortcut}</span>
            ) : null}
          </button>
        </Popover>
      ) : null}

      {open && flyout === "branch" && current ? (
        <Popover
          anchor={branchRow}
          side="right"
          align="start"
          gap={-4}
          width={280}
          maxHeight={380}
          layer={LAYER.submenu}
          ignore={PROJECT_MENU}
          onDismiss={() => (branchBusy ? undefined : closeFlyout())}
          role="dialog"
          aria-label="切换分支"
          data-project-menu
          className="flex flex-col overflow-hidden"
          onKeyDown={onFlyoutKeyDown}
        >
          <SearchField
            inputRef={search}
            value={query}
            placeholder="搜索或新建分支…"
            label="搜索分支"
            onChange={(value) => {
              setQuery(value);
              setActive(0);
            }}
          />
          <div role="listbox" aria-label="分支" className="min-h-0 flex-1 overflow-y-auto overscroll-none p-1.5">
            {branches.isPending ? (
              <div className="flex items-center gap-2 p-2 text-[12px] text-content/50">
                <Loader className="size-3.5 animate-spin" />
                载入分支…
              </div>
            ) : null}
            {branchRows.map((branch, index) => {
              const selected = branch.name === currentBranch;
              return (
                <button
                  key={branch.name}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  title={branch.name}
                  disabled={Boolean(branchBusy)}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => void pickBranch(branch.name)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left disabled:opacity-40 ${
                    index === active ? "bg-selection" : "hover:bg-content/5"
                  }`}
                >
                  <GitBranch className="size-3.5 shrink-0 text-content/50" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1 truncate text-[12px]">{branch.name}</span>
                  {branchBusy === branch.name ? <Loader className="size-3.5 shrink-0 animate-spin" /> : null}
                  {selected ? <Check className="size-3.5 shrink-0" /> : null}
                </button>
              );
            })}
            {!branches.isPending && branchRows.length === 0 ? (
              <p className="px-2.5 py-5 text-center text-[12px] text-content/45">没有匹配的分支</p>
            ) : null}
          </div>
          {canCreateBranch ? (
            <div className="shrink-0 border-t border-stroke p-1.5">
              <button
                type="button"
                disabled={Boolean(branchBusy)}
                onClick={() => void createBranch()}
                className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-content/75 hover:bg-content/8 hover:text-content disabled:opacity-60"
              >
                {branchBusy === branchCreateName ? (
                  <Loader className="size-4 shrink-0 animate-spin" />
                ) : (
                  <Plus className="size-4 shrink-0" strokeWidth={1.75} />
                )}
                <span className="min-w-0 truncate">新建分支 {branchCreateName}</span>
              </button>
            </div>
          ) : null}
        </Popover>
      ) : null}

      {open && flyout === "project" ? (
        <Popover
          anchor={projectRow}
          side="right"
          align="start"
          gap={-4}
          width={286}
          maxHeight={380}
          layer={LAYER.submenu}
          ignore={PROJECT_MENU}
          onDismiss={closeFlyout}
          role="dialog"
          aria-label="切换项目"
          data-project-menu
          className="flex flex-col overflow-hidden"
          onKeyDown={onFlyoutKeyDown}
        >
          <SearchField
            inputRef={search}
            value={query}
            placeholder="搜索项目…"
            label="搜索项目"
            onChange={(value) => {
              setQuery(value);
              setActive(0);
            }}
          />
          <div role="listbox" aria-label="项目" className="min-h-0 flex-1 overflow-y-auto overscroll-none p-1.5">
            {projectRows.map((project, index) => {
              const selected = project.path === current?.path;
              return (
                <button
                  key={project.path}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  title={project.path}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pickProject(project.path)}
                  className={`flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left ${
                    index === active
                      ? "bg-selection text-content"
                      : "text-content/75 hover:bg-content/5 hover:text-content"
                  }`}
                >
                  <span className="grid size-4 shrink-0 place-items-center">
                    {selected ? (
                      <Check className="size-3.5" strokeWidth={2} />
                    ) : (
                      <ProjectMark project={project} />
                    )}
                  </span>
                  <span className="min-w-0 max-w-[calc(100%-36px)] shrink-0 truncate text-[13px] font-medium">
                    {project.name}
                  </span>
                  <span className="min-w-0 max-w-28 flex-1 truncate font-mono text-[11px] text-content/40">
                    {prettyCwd(parentPath(project.path))}
                  </span>
                </button>
              );
            })}
            {projectRows.length === 0 ? (
              <p className="px-2.5 py-5 text-center text-[12px] text-content/45">没有匹配的项目</p>
            ) : null}
          </div>
          {onAddProject || onOpenHome ? (
            <div className="shrink-0 border-t border-stroke p-1.5">
              {onOpenHome ? (
                <button
                  type="button"
                  onClick={() => {
                    close();
                    onOpenHome();
                  }}
                  className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-content/75 hover:bg-content/8 hover:text-content"
                >
                  <Folder className="size-4 shrink-0" strokeWidth={1.75} />
                  <span>不在文件夹里工作</span>
                </button>
              ) : null}
              {onAddProject ? (
                <button
                  type="button"
                  onClick={() => {
                    close();
                    onAddProject();
                  }}
                  className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-content/75 hover:bg-content/8 hover:text-content"
                >
                  <Plus className="size-4 shrink-0" strokeWidth={1.75} />
                  <span>新建项目</span>
                </button>
              ) : null}
            </div>
          ) : null}
        </Popover>
      ) : null}
    </>
  );
}

/** 项目图标：Logo 图片优先，否则用该项目的派生色，当前项目用打开态。 */
function ProjectMark({ project, open = false }: { project: Project; open?: boolean }) {
  if (project.logoPath) {
    return <img src={convertFileSrc(project.logoPath)} alt="" className="size-4 shrink-0 rounded object-cover" />;
  }
  const color = projectColor(project) ?? derivedProjectColor(project.path);
  return (
    <span className="shrink-0" style={{ color }}>
      {open ? (
        <FolderOpen className="size-4 opacity-70" strokeWidth={1.75} aria-hidden />
      ) : (
        <Folder className="size-4 opacity-70" strokeWidth={1.75} aria-hidden />
      )}
    </span>
  );
}

/** 浮层顶部的搜索框；两个浮层的尺寸和排版保持一致。 */
function SearchField({
  inputRef,
  value,
  placeholder,
  label,
  onChange,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  placeholder: string;
  label: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex h-11 shrink-0 items-center gap-2.5 border-b border-stroke px-3 text-content/45 focus-within:text-content/70">
      <Search className="size-4 shrink-0" strokeWidth={1.75} />
      <span className="sr-only">{label}</span>
      <input
        ref={inputRef}
        value={value}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-0 flex-1 bg-transparent text-[13px] text-content outline-none placeholder:text-content/35"
      />
    </label>
  );
}
