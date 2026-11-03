// @vitest-environment happy-dom
/**
 * 手机端要 attach 的必须是**电脑端起的连接 id**。
 *
 * 手机没有自己的工作区进程：id 由电脑端窗口创建。本地编一个
 * `<cwd>#<uuid>` 去 attach，Host 只会回「桌面连接不存在或已经关闭」——
 * 表现就是项目列表和会话列表都是最新的，但点会话没反应、发不出消息、
 * 也选不了模型（那条连接根本没 attach 上）。所以这里钉住解析顺序：
 * 快照 → Host resolve → 让电脑端 `project.open` 并等它出现。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const remoteHostSnapshot = vi.fn();
const resolveRemoteConnection = vi.fn();
const runRemoteHostOperation = vi.fn();
const waitForRemoteConnection = vi.fn();

vi.mock("./remote-runtime", () => ({
  attachRemoteConnection: vi.fn(),
  remoteHostSnapshot: () => remoteHostSnapshot(),
  resolveRemoteConnection: (cwd: string) => resolveRemoteConnection(cwd),
  runRemoteHostOperation: (operation: unknown) => runRemoteHostOperation(operation),
  waitForRemoteConnection: (cwd: string) => waitForRemoteConnection(cwd),
  sendRemotePiCommand: vi.fn(),
}));

vi.mock("./native", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  isTauri: () => false,
  Channel: class {},
}));

import { resolveWorkspaceConnection } from "./rpc-connection";

const lan = { id: "desk-1", cwd: "/work/pi-gui" };

beforeEach(() => {
  remoteHostSnapshot.mockReset();
  resolveRemoteConnection.mockReset();
  runRemoteHostOperation.mockReset();
  waitForRemoteConnection.mockReset();
  remoteHostSnapshot.mockResolvedValue({ connections: [], projects: [] });
});

describe("resolveWorkspaceConnection", () => {
  it("快照里已经有这个项目，就直接用电脑端那个 id", async () => {
    remoteHostSnapshot.mockResolvedValue({ connections: [lan] });
    await expect(resolveWorkspaceConnection("/work/pi-gui")).resolves.toEqual(lan);
    expect(resolveRemoteConnection).not.toHaveBeenCalled();
    expect(runRemoteHostOperation).not.toHaveBeenCalled();
  });

  it("路径写法不同（符号链接 / 尾斜杠）时问 Host，拿它的规范答案", async () => {
    resolveRemoteConnection.mockResolvedValue(lan);
    await expect(resolveWorkspaceConnection("/work/pi-gui/")).resolves.toEqual(lan);
    expect(runRemoteHostOperation).not.toHaveBeenCalled();
  });

  it("项目在电脑端没开：让电脑端打开它，不是自己编一个 id", async () => {
    resolveRemoteConnection.mockResolvedValue(undefined);
    runRemoteHostOperation.mockResolvedValue(lan);
    await expect(resolveWorkspaceConnection("/work/pi-gui")).resolves.toEqual(lan);
    expect(runRemoteHostOperation).toHaveBeenCalledWith({ name: "project.open", path: "/work/pi-gui" });
    // 答案里已经带连接，就不用再等。
    expect(waitForRemoteConnection).not.toHaveBeenCalled();
  });

  it("打开是异步的：答案是空的就等连接出现", async () => {
    resolveRemoteConnection.mockResolvedValue(undefined);
    runRemoteHostOperation.mockResolvedValue(undefined);
    waitForRemoteConnection.mockResolvedValue(lan);
    await expect(resolveWorkspaceConnection("/work/pi-gui")).resolves.toEqual(lan);
    expect(waitForRemoteConnection).toHaveBeenCalledWith("/work/pi-gui");
  });

  it("电脑端确实没有这个项目时点名，而不是拿一个不存在的 id 去 attach", async () => {
    resolveRemoteConnection.mockResolvedValue(undefined);
    runRemoteHostOperation.mockResolvedValue(undefined);
    waitForRemoteConnection.mockResolvedValue(undefined);
    await expect(resolveWorkspaceConnection("/work/pi-gui")).rejects.toThrow(/电脑端没有这个项目的活动连接/);
  });
});
