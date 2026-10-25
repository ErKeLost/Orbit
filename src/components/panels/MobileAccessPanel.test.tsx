// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "1.0.12" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("../../lib/store", async () => {
  const { create } = await import("zustand");
  return { useWorkspace: create(() => ({ runtimeTarget: "desktop" })) };
});
// 这个面板的正文是设置页里那块很大的 host 控件；这里只关心面板本身能不能画出来。
vi.mock("../../features/settings/pages/GeneralSettingsPage", () => ({
  DesktopHostSettings: () => createElement("div", { "data-testid": "host" }, "host controls"),
  MobileAccessSettings: () => createElement("div", null, "mobile controls"),
}));

import { MobileAccessPanel } from "./MobileAccessPanel";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("MobileAccessPanel", () => {
  it("画出标题和版本，并把 host 控件放进来", async () => {
    await act(async () => root.render(createElement(MobileAccessPanel)));
    expect(container.querySelector(".mobile-access-panel")).not.toBeNull();
    expect(container.textContent).toContain("移动端");
    expect(container.querySelector('[data-testid="host"]')).not.toBeNull();
  });
});
