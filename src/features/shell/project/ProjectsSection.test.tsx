// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => path }));

import { ProjectsSection } from "./ProjectsSection";
import type { Project } from "../../../lib/projects";

const projects: Project[] = [
  { path: "/work/pi-gui", name: "pi-gui" },
  { path: "/work/create-x", name: "create-x", roots: ["/work/create-x", "/work/create-x-backend"] },
  { path: "/work/site", name: "orbit-site", pinned: true },
];

let container: HTMLDivElement;
let root: Root;
let selected: string[];
let opened: { path: string; x: number; y: number }[];
let reordered: string[][];
let added: number;
let home: number;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  selected = [];
  opened = [];
  reordered = [];
  added = 0;
  home = 0;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function render(props: Partial<Parameters<typeof ProjectsSection>[0]> = {}) {
  await act(async () =>
    root.render(
      createElement(ProjectsSection, {
        projects,
        currentPath: "/work/pi-gui",
        onSelect: (path: string) => selected.push(path),
        onOpenMenu: (project: Project, x: number, y: number) => opened.push({ path: project.path, x, y }),
        onReorder: (paths: string[]) => reordered.push(paths),
        onAdd: () => { added += 1; },
        onHome: () => { home += 1; },
        ...props,
      }),
    ),
  );
}

const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find((node) => node.textContent?.includes(label)) ?? null;

/** 图标按钮只有 aria-label。 */
const iconButton = (label: string) => document.body.querySelector(`button[aria-label="${label}"]`);

const row = (path: string) => document.body.querySelector(`[data-project-row="${path}"]`);

async function click(node: Element | null) {
  if (!node) throw new Error("element missing");
  await act(async () => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("ProjectsSection", () => {
  it("把每个项目列成一行，当前项目是选中态", async () => {
    await render();
    expect(container.textContent).toContain("项目");
    expect(container.textContent).toContain("pi-gui");
    expect(container.textContent).toContain("create-x");
    expect(container.textContent).toContain("orbit-site");
    expect(row("/work/pi-gui")?.hasAttribute("data-selected")).toBe(true);
    expect(row("/work/create-x")?.hasAttribute("data-selected")).toBe(false);
  });

  it("点另一个项目就切过去，右上角的选项按钮不会误触切换", async () => {
    await render();
    await click(button("create-x"));
    expect(selected).toEqual(["/work/create-x"]);

    await click(iconButton("create-x 项目选项"));
    expect(selected).toEqual(["/work/create-x"]);
    expect(opened.map((item) => item.path)).toEqual(["/work/create-x"]);
  });

  it("首页（不在项目里）时没有一行是选中的", async () => {
    await render({ currentPath: undefined });
    expect(row("/work/pi-gui")?.hasAttribute("data-selected")).toBe(false);
  });

  it("多 root 的项目不报数字，全部路径交给 title", async () => {
    await render();
    expect(row("/work/create-x")?.getAttribute("data-project-roots")).toBe("2");
    expect(row("/work/pi-gui")?.getAttribute("data-project-roots")).toBe("1");
    // 行里只有名字：数量不占位，完整路径放在 title 里。
    const title = row("/work/create-x")?.querySelector("button")?.getAttribute("title") ?? "";
    expect(title).toContain("/work/create-x-backend");
    expect(row("/work/create-x")?.textContent).toBe("create-x");
  });

  it("加号菜单里有「打开文件夹…」和「不在文件夹里工作」", async () => {
    await render();
    await click(iconButton("打开项目"));
    await click(button("打开文件夹…"));
    expect(added).toBe(1);

    await click(iconButton("打开项目"));
    await click(button("不在文件夹里工作"));
    expect(home).toBe(1);
  });

  it("没有项目时给一个图标入口，不写「还没有项目」也不报 0", async () => {
    await render({ projects: [] });
    expect(container.textContent).not.toContain("还没有项目");
    expect(container.textContent?.trim()).toBe("项目");
    const empty = iconButton("打开文件夹");
    expect(empty).not.toBeNull();
    await click(empty);
    expect(added).toBe(1);
  });

  it("右键一行打开项目菜单，不是浏览器的默认菜单", async () => {
    await render();
    const target = row("/work/site");
    if (!target) throw new Error("row missing");
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 });
    await act(async () => {
      target.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(opened).toEqual([{ path: "/work/site", x: 40, y: 60 }]);
  });
});
