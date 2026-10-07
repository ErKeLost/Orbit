import { useWorkspace } from "../../lib/store";
import { useProjects } from "../../lib/projects";
import { connect, report } from "../../lib/rpc";
import { PanelLeft, Plus, Settings } from "../../shared/ui/icons";
import { ProjectInitial } from "./ProjectInitial";
import { IS_MAC } from "./chrome";
import { useShell } from "./shellStore";
import { toast } from "../../shared/ui/toast";

/** MonoCode's compact icon rail: projects only, one click back to the full rail. */
export function CompactRail() {
  const cwd = useWorkspace((state) => state.cwd);
  const workspaceMode = useWorkspace((state) => state.workspaceMode);
  const liveSessions = useWorkspace((state) => state.liveSessions);
  const { projects } = useProjects();
  const setProjectRailOpen = useShell((state) => state.setProjectRailOpen);
  const running = new Set(liveSessions.filter((s) => s.running).map((s) => s.cwd));

  return (
    <nav aria-label="Projects" className={`body-glass flex h-full w-12 shrink-0 flex-col items-center border-r border-stroke ${IS_MAC ? "pt-10" : ""}`}>
      <button
        type="button"
        title="展开项目栏"
        aria-label="展开项目栏"
        onClick={() => setProjectRailOpen(true)}
        className="grid h-10 w-full shrink-0 place-items-center border-b border-stroke text-content/50 hover:bg-content/10 hover:text-content"
      >
        <PanelLeft className="size-4" strokeWidth={1.75} />
      </button>
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto py-2">
        {projects.map((project) => {
          const selected = workspaceMode === "project" && project.path === cwd;
          return (
            <button
              key={project.path}
              type="button"
              title={project.name}
              aria-label={project.name}
              aria-current={selected ? "true" : undefined}
              onClick={() => {
                if (selected) { setProjectRailOpen(true); return; }
                void connect(project.path, "project").catch(report);
              }}
              className={`relative grid size-8 shrink-0 place-items-center rounded-md ${selected ? "bg-selection-strong text-content" : "text-content/70 hover:bg-content/10"}`}
            >
              <ProjectInitial name={project.name} className="size-4" />
              {running.has(project.path) ? <span aria-hidden className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-accent" /> : null}
            </button>
          );
        })}
        <button
          type="button"
          title="添加项目"
          aria-label="添加项目"
          onClick={() => { setProjectRailOpen(true); toast.info("在展开的项目栏里点击 + 添加项目"); }}
          className="grid size-8 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content"
        >
          <Plus className="size-4" strokeWidth={1.75} />
        </button>
      </div>
      <button
        type="button"
        title="设置"
        aria-label="设置"
        onClick={() => useWorkspace.getState().set({ panel: "settings", settingsPage: "general" })}
        className="grid h-10 w-full shrink-0 place-items-center border-t border-stroke text-content/50 hover:bg-content/10 hover:text-content"
      >
        <Settings className="size-4" strokeWidth={1.75} />
      </button>
    </nav>
  );
}
