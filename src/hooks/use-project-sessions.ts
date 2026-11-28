import { useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useMemo } from "react";
import { normalizeProjectPath } from "../lib/projects";
import type { Session } from "../lib/protocol";
import type { LiveSession } from "../lib/store";
import { listSessions } from "../lib/rpc";
import { useWorkspace } from "../lib/store";

export function useProjectSessions(cwd: string) {
  const runtimeTarget = useWorkspace(state => state.runtimeTarget);
  return useQuery({
    queryKey: ["pi", "sessions", cwd],
    queryFn: () => listSessions(cwd),
    enabled: (runtimeTarget === "desktop" || runtimeTarget === "mobile") && Boolean(cwd),
  });
}

const sessionRows = (queries: UseQueryResult<Session[]>[]) => queries.map(query => query.data);

export function useProjectSessionGroups(projects: string[]) {
  const runtimeTarget = useWorkspace(state => state.runtimeTarget);
  const queries = useQueries({
    queries: projects.map(cwd => ({
      queryKey: ["pi", "sessions", cwd],
      queryFn: () => listSessions(cwd),
      enabled: (runtimeTarget === "desktop" || runtimeTarget === "mobile") && Boolean(cwd),
    })),
    combine: sessionRows,
  });
  return useMemo(() => projects.map((cwd, index) => ({ cwd, listed: queries[index] })), [projects, queries]);
}

export function mergeProjectSessions(cwd: string, listed: Session[], live: LiveSession[]) {
  const listedPaths = new Set(listed.map(session => session.path));
  const seen = new Set(listedPaths);
  const scope = normalizeProjectPath(cwd);
  const sessions: Session[] = [...listed];
  for (const session of live) {
    if (!session.path || normalizeProjectPath(session.cwd) !== scope || seen.has(session.path)) continue;
    seen.add(session.path);
    sessions.push({
      path: session.path,
      id: session.path,
      cwd,
      firstMessage: session.title,
      messageCount: 0,
      modified: session.modified ?? "",
    });
  }
  sessions.sort(compareSessionActivity);
  return { listedPaths, sessions };
}

export function compareSessionActivity(a: Session, b: Session) {
  const aTime = Date.parse(a.modified);
  const bTime = Date.parse(b.modified);
  const difference = (Number.isFinite(bTime) ? bTime : -Infinity) - (Number.isFinite(aTime) ? aTime : -Infinity);
  return difference || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
