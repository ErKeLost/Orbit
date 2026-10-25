// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const checkout = vi.fn(async () => undefined);
const createBranch = vi.fn(async () => "feature/new");

vi.mock("../../../lib/git", () => ({
  useGitBranches: () => ({
    data: {
      current: "main",
      detached: false,
      branches: [
        { name: "main", current: true, remote: null },
        { name: "feat/rail", current: false, remote: null },
      ],
    },
    isPending: false,
  }),
  gitCheckout: (...args: unknown[]) => checkout(...(args as [])),
  gitCreateBranch: (...args: unknown[]) => createBranch(...(args as [])),
}));

vi.mock("../../../lib/rpc", () => ({ report: vi.fn() }));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => path }));

import { ProjectSwitcher } from "./ProjectSwitcher";
import type { Project } from "../../../lib/projects";

const projects: Project[] = [
  { path: "/work/pi-gui", name: "pi-gui" },
  { path: "/work/orbit-site", name: "orbit-site" },
];

let container: HTMLDivElement;
let root: Root;
let selected: string[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  selected = [];
  checkout.mockClear();
  createBranch.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () =>
    root.render(
      createElement(ProjectSwitcher, {
        current: projects[0],
        projects,
        onSelectProject: (path: string) => selected.push(path),
        onOpenProjectMenu: vi.fn(),
        onOpenSettings: vi.fn(),
        settingsShortcut: "⌘,",
      }),
    ),
  );
}

const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find((node) => node.textContent?.includes(label)) ?? null;

async function click(node: Element | null) {
  if (!node) throw new Error("element missing");
  await act(async () => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("ProjectSwitcher", () => {
  it("把项目名和分支放在标题上，切换项都在菜单里", async () => {
    await render();
    expect(container.textContent).toContain("pi-gui");
    expect(container.textContent).toContain("main");
    // 标题下面没有项目列表：切换是菜单的事。
    expect(button("orbit-site")).toBeNull();

    await click(button("pi-gui"));

    for (const label of ["切换分支", "切换项目", "项目设置", "设置"])
      expect(button(label)).not.toBeNull();
    expect(button("⌘,")).not.toBeNull();
  });

  it("切换项目列出所有项目，选中当前那个，点另一个就切过去", async () => {
    await render();
    await click(button("pi-gui"));
    await click(button("切换项目"));

    const options = [...document.body.querySelectorAll('[role="option"]')];
    expect(options.map((node) => node.textContent)).toEqual([
      expect.stringContaining("pi-gui"),
      expect.stringContaining("orbit-site"),
    ]);
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    expect(options[1].getAttribute("aria-selected")).toBe("false");

    await click(options[1]);
    expect(selected).toEqual(["/work/orbit-site"]);
  });

  it("切换分支时当前分支不重复切换", async () => {
    await render();
    await click(button("pi-gui"));
    await click(button("切换分支"));

    const options = [...document.body.querySelectorAll('[role="option"]')];
    expect(options[0].getAttribute("aria-selected")).toBe("true");

    await click(options[0]);
    expect(checkout).not.toHaveBeenCalled();

    await click(button("切换分支"));
    const rows = [...document.body.querySelectorAll('[role="option"]')];
    await click(rows[1]);
    expect(checkout).toHaveBeenCalledWith("/work/pi-gui", "feat/rail");
  });
});
