import { beforeEach, describe, expect, test } from "bun:test";
import { HOME_WORKSPACE_ID, useShell, type WorkspaceTab } from "../src/features/shell/shellStore";

/**
 * header 上的标签是挂项目的：关掉一个项目的最后一页，要落回**这个项目**的新会话
 * 面，而不是被顺手丢进另一个项目还开着的标签页里。
 */
const tab = (id: string, cwd: string) => ({ id, cwd }) as unknown as WorkspaceTab;
const home = (cwd = "/a") => tab(HOME_WORKSPACE_ID, cwd);

function seed(workspaces: WorkspaceTab[], active: string) {
  useShell.setState({ workspaces, activeWorkspaceId: active, activeByProject: {} });
}

describe("closing a workspace tab", () => {
  beforeEach(() => seed([home()], HOME_WORKSPACE_ID));

  test("最后一个标签关掉后回首页，不会跳到别的项目", () => {
    seed([home("/b"), tab("a1", "/a"), tab("b1", "/b")], "a1");
    useShell.getState().closeWorkspace("a1");
    expect(useShell.getState().activeWorkspaceId).toBe(HOME_WORKSPACE_ID);
    expect(useShell.getState().workspaces.map((item) => item.id)).toEqual([HOME_WORKSPACE_ID, "b1"]);
  });

  test("同一项目还有别的标签时落到那个标签", () => {
    seed([home("/a"), tab("a1", "/a"), tab("a2", "/a"), tab("b1", "/b")], "a2");
    useShell.getState().closeWorkspace("a2");
    expect(useShell.getState().activeWorkspaceId).toBe("a1");
  });

  test("关掉的不是当前标签时，当前标签不动", () => {
    seed([home("/a"), tab("a1", "/a"), tab("a2", "/a"), tab("b1", "/b")], "b1");
    useShell.getState().closeWorkspace("a2");
    expect(useShell.getState().activeWorkspaceId).toBe("b1");
    expect(useShell.getState().workspaces.map((item) => item.id)).toEqual([HOME_WORKSPACE_ID, "a1", "b1"]);
  });

  test("路径末尾多一个斜杠也算同一个项目", () => {
    seed([home("/a"), tab("a1", "/a/"), tab("a2", "/a")], "a2");
    useShell.getState().closeWorkspace("a2");
    expect(useShell.getState().activeWorkspaceId).toBe("a1");
  });
});
