import { describe, expect, test } from "bun:test";
import { dayStart, groupSessionsByDay } from "../src/features/shell/sessions/session-day";
import { removeSessionViews } from "../src/features/shell/sessions/session-views";
import { newHomeWorkspace, newWorkspaceTab } from "../src/features/shell/shellModel";
import { placeNewPane } from "../src/features/shell/paneLayout";
import { mergeProjectSessions } from "../src/hooks/use-project-sessions";

const today = new Date(2026, 10, 28, 15).getTime();
const row = (day: number, path: string) => ({ session: { path, modified: new Date(dayStart(today, day)).toISOString() } });

describe("sidebar session dates", () => {
  test("removing the last row in a group removes its heading and keeps the other section keys", () => {
    const recent = row(-4, "recent");
    const yesterday = row(-1, "yesterday");
    const groups = groupSessionsByDay([row(0, "today"), yesterday, recent], dayStart(today));
    const remaining = groupSessionsByDay([yesterday, recent], dayStart(today));
    expect(remaining).toEqual(groups.slice(1));
  });

  test("switches date groups at the local calendar boundary and keeps unknown dates last", () => {
    const entries = [row(0, "today"), row(-1, "yesterday"), row(-6, "week"), { session: { path: "unknown", modified: "" } }];
    const groups = groupSessionsByDay(entries, dayStart(today, 1));
    expect(groups.map(group => [group.id, group.items.map(item => item.session.path)])).toEqual([
      ["yesterday", ["today"]], ["week", ["yesterday"]], ["older", ["week", "unknown"]],
    ]);
  });

  test("live status updates preserve the activity timestamp and never add a second row", () => {
    const modified = row(-1, "live").session.modified;
    const live = { cwd: "/project/", path: "live", title: "Session", running: true, modified };
    const existing = { ...live, cwd: "/project", id: "session", firstMessage: "Saved", messageCount: 1 };
    expect(mergeProjectSessions("/project", [], [live]).sessions[0]?.modified).toBe(modified);
    expect(mergeProjectSessions("/project", [], [{ ...live, running: false }]).sessions[0]?.modified).toBe(modified);
    expect(mergeProjectSessions("/project", [existing], [live]).sessions).toEqual([existing]);
  });
});

const tab = (id: string, cwd = "/project") => ({ ...newWorkspaceTab(cwd, `connection-${id}`), id, sessionPath: `/sessions/${id}` });

describe("deleting a session view", () => {
  test("closes both live and dormant tabs and selects the nearest surviving tab in the same project", () => {
    const a = tab("a"), b = tab("b"), c = tab("c"), foreign = tab("foreign", "/other");
    const duplicate = { ...tab("duplicate"), connectionId: "", sessionPath: b.sessionPath };
    const home = newHomeWorkspace("/project");
    const state = { workspaces: [a, duplicate, b, foreign, c, home], activeWorkspaceId: b.id, activeByProject: { "/project": b.id, "/other": foreign.id } };
    const next = removeSessionViews(state, b.sessionPath, new Set([b.connectionId]));
    expect(next.workspaces).toEqual([a, foreign, c, home]);
    expect(next.activeWorkspaceId).toBe(a.id);
    expect(next.activeByProject).toEqual({ "/other": foreign.id });
  });

  test("deleting a background session keeps the active tab, even across projects", () => {
    const a = tab("a"), b = tab("b", "/other");
    const state = { workspaces: [a, b], activeWorkspaceId: a.id, activeByProject: {} };
    const next = removeSessionViews(state, b.sessionPath, new Set([b.connectionId]));
    expect(next.activeWorkspaceId).toBe(a.id);
    expect(next.workspaces).toEqual([a]);
  });

  test("deleting a split session keeps its sibling and avoids reviving the deleted path", () => {
    const a = tab("a");
    a.layout = placeNewPane(a.layout, "chat", "session:1", "right");
    a.sessions["session:1"] = { connectionId: "connection-b" };
    const next = removeSessionViews({ workspaces: [a], activeWorkspaceId: a.id, activeByProject: {} }, a.sessionPath, new Set([a.connectionId]));
    expect(next.workspaces[0]).toMatchObject({ connectionId: "connection-b", sessions: { "session:1": { connectionId: "connection-b" } }, activePane: "session:1" });
    expect(next.workspaces[0]?.sessionPath).toBeUndefined();
  });
});
