// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../files/FileTree", () => ({
  FileTree: ({ cwd }: { cwd: string }) => createElement("div", { "data-testid": "tree" }, cwd),
}));

vi.mock("../../source-control/ui/GitHistoryGraph", () => ({
  GitHistoryGraph: ({ cwd }: { cwd: string }) =>
    createElement("div", { "data-testid": "graph" }, cwd),
}));

vi.mock("../../source-control/hooks/useGitHead", () => ({
  useGitHead: () => ({ files: [{ path: "a" }, { path: "b" }, { path: "c" }, { path: "d" }] }),
}));

vi.mock("../../../lib/store", async () => {
  const { create } = await import("zustand");
  const store = create(() => ({ cwd: "/work/pi-gui", homeDir: "/Users/me" }));
  return { useWorkspace: store };
});

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/api/core")>(),
  invoke: async () => undefined,
  convertFileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: async () => {}, revealItemInDir: async () => {} }));

import { openArtifactPanel } from "../../artifacts/ui/openArtifact";
import { InspectorPanel } from "./InspectorPanel";
import { ARTIFACT_PREVIEW_DEFAULT_WIDTH, useShell } from "../shellStore";

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("innerWidth", 1400);
  useShell.setState({
    inspectorOpen: true,
    inspectorTab: "explorer",
    inspectorArtifact: null,
    inspectorWidth: 260,
    artifactPreviewWidth: ARTIFACT_PREVIEW_DEFAULT_WIDTH,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = async (visible = true) => {
  await act(async () => root.render(createElement(InspectorPanel, { visible, online: true })));
};

const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
/** 两个分段都常驻挂载（切回来不重建），所以只比「谁被隐藏」。 */
const showing = (id: "tree" | "graph") => {
  let node: HTMLElement | null | undefined = container.querySelector(`[data-testid="${id}"]`);
  while (node) {
    if (node.className?.split(/\s+/).includes("hidden")) return false;
    node = node.parentElement;
  }
  return true;
};

describe("InspectorPanel", () => {
  it("文件与历史两个分段，变更数挂在文件上", async () => {
    await render();
    expect(tabs().map((tab) => tab.textContent)).toEqual(["文件+4", "历史"]);
    expect(tabs()[0].getAttribute("aria-selected")).toBe("true");
    expect(showing("tree")).toBe(true);
    expect(showing("graph")).toBe(false);
  });

  it("点历史换分段，点回当前分段收起整栏", async () => {
    await render();

    await act(async () => tabs()[1].dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(useShell.getState().inspectorTab).toBe("history");
    expect(showing("graph")).toBe(true);
    expect(showing("tree")).toBe(false);

    await act(async () => tabs()[1].dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(useShell.getState().inspectorOpen).toBe(false);
  });

  it("产物能拖过文件栏的宽度上限，关闭后再打开仍保留宽度，双击恢复默认", async () => {
    await render();
    await act(async () => openArtifactPanel("report"));
    const preview = () => container.querySelector<HTMLElement>('aside[aria-label="产物"]')!;
    const divider = () => preview().querySelector<HTMLElement>('[aria-label="调整产物预览宽度"]')!;
    divider().setPointerCapture = vi.fn();
    divider().releasePointerCapture = vi.fn();

    await act(async () => {
      divider().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 900 }));
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 640 }));
    });
    expect(preview().style.width).toBe("720px");
    expect(localStorage.getItem("orbit.shell.artifactPreviewWidth")).toBe("720");

    await act(async () => preview().querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.click());
    expect(container.querySelector<HTMLElement>('aside[aria-label="项目检视栏"]')?.style.width).toBe("260px");
    await act(async () => openArtifactPanel("another-report"));
    expect(preview().style.width).toBe("720px");

    await act(async () => divider().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(preview().style.width).toBe(`${ARTIFACT_PREVIEW_DEFAULT_WIDTH}px`);
    expect(useShell.getState().inspectorWidth).toBe(260);
  });

  it("没有项目工作区时整栏不渲染", async () => {
    await render(false);
    expect(container.querySelector("aside")).toBeNull();
  });
});
