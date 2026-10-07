import { useMemo } from "react";
import { useWorkspace } from "../../lib/store";
import { useProjects } from "../../lib/projects";
import { NotesView } from "../../features/notes/ui/NotesView";
import type { RecentProject } from "../../features/projects/model/recents";

/** Hosts the notes surface inside Orbit's full-page panel area. */
export function NotesPanel() {
  const cwd = useWorkspace((state) => state.cwd);
  const projects = useProjects((state) => state.projects);
  const recents = useMemo<RecentProject[]>(
    () =>
      projects.map((project, index) => ({
        path: project.path,
        openedAt: projects.length - index,
      })),
    [projects],
  );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <NotesView
        cwd={cwd || undefined}
        recents={recents}
        onClose={() => useWorkspace.getState().set({ panel: "chat" })}
      />
    </div>
  );
}

export default NotesPanel;
