// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveArtifact = vi.fn(async () => ({}) as never);

vi.mock("./artifacts", () => ({
  saveArtifact: (...args: unknown[]) => saveArtifact(...(args as [])),
}));

vi.mock("../../lib/store", async () => {
  const { create } = await import("zustand");
  const store = create(() => ({
    statuses: {} as Record<string, string>,
    cwd: "/work/pi-gui",
    state: { sessionFile: "session.jsonl" },
  }));
  return { useWorkspace: store };
});

import { ARTIFACT_STATUS, useArtifactIntake } from "./useArtifactIntake";
import { useWorkspace } from "../../lib/store";

function Harness() {
  useArtifactIntake();
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  saveArtifact.mockClear();
  useWorkspace.setState({ statuses: {}, cwd: "/work/pi-gui", state: { sessionFile: "session.jsonl" } as never });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Harness)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const publish = async (payload: unknown) => {
  await act(async () => {
    useWorkspace.setState({ statuses: { [ARTIFACT_STATUS]: JSON.stringify(payload) } });
  });
};

describe("useArtifactIntake", () => {
  it("把 agent 发布的产物落库，并带上当前目录", async () => {
    await publish({ id: "board", kind: "html", title: "看板", body: "<h1>hi</h1>" });
    expect(saveArtifact).toHaveBeenCalledTimes(1);
    expect(saveArtifact.mock.calls[0][0]).toMatchObject({
      id: "board",
      kind: "html",
      title: "看板",
      body: "<h1>hi</h1>",
      sourceCwd: "/work/pi-gui",
      sourceSessionId: "session.jsonl",
    });
  });

  it("同一个 payload 只落一次（重启 / 重渲染都不会重复写）", async () => {
    await publish({ id: "board", kind: "document", title: "a", body: "x" });
    await act(async () => {
      useWorkspace.setState({ statuses: { [ARTIFACT_STATUS]: JSON.stringify({ id: "board", kind: "document", title: "a", body: "x" }) } });
    });
    expect(saveArtifact).toHaveBeenCalledTimes(1);
  });

  it("空 body 和坏 JSON 都不写", async () => {
    await publish({ id: "empty", kind: "document", title: "空的", body: "   " });
    await act(async () => {
      useWorkspace.setState({ statuses: { [ARTIFACT_STATUS]: "{not json" } });
    });
    expect(saveArtifact).not.toHaveBeenCalled();
  });

  it("缺 kind 时按文档处理", async () => {
    await publish({ id: "plain", title: "t", body: "hello" });
    expect(saveArtifact.mock.calls[0][0]).toMatchObject({ kind: "document" });
  });
});
