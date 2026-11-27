import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import type { DirEntry } from "../../../lib/git";
import { FileTree } from "./FileTree";

const listDir = vi.hoisted(() => vi.fn<(path: string) => Promise<DirEntry[]>>());
vi.mock("../../../lib/git", () => ({ listDir, useGitChangedFiles: () => ({}) }));
vi.mock("../FileTypeIcon", () => ({ FileTypeIcon: () => null }));

const entry = (path: string, isDir = false, ignored = false): DirEntry => ({
  path,
  name: path.split("/").at(-1)!,
  isDir,
  ignored,
});

test("reveals an active file after its ancestors load and follows tab changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const cwd = "/reveal-fixture";
  const folder = `${cwd}/nested`;
  const first = `${folder}/first.ts`;
  const other = `${cwd}/other.ts`;
  const pending = Promise.withResolvers<DirEntry[]>();
  listDir.mockImplementation(async (path) => {
    if (path === cwd) return [entry(folder, true, true), entry(other)];
    if (path === folder) return pending.promise;
    throw new Error(`Unexpected directory ${path}`);
  });
  const findRow = (path: string) => host.querySelector<HTMLButtonElement>(`[role="treeitem"][title="${path}"]`);
  const show = (activeFile: string, visible = true) => act(async () => {
    root.render(<div hidden={!visible}><FileTree cwd={cwd} activeFile={activeFile} visible={visible} /></div>);
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.title === first) return new DOMRect(0, 210, 200, 30);
    if (this.title === other) return new DOMRect(0, 20, 200, 30);
    return new DOMRect(0, 40, 200, 120);
  });
  try {
    await show(first, false);
    const scroller = host.querySelector<HTMLElement>('[role="tree"]')!.parentElement!;
    expect(findRow(first)).toBeNull();
    expect(listDir).not.toHaveBeenCalledWith(folder);
    await show(first);
    expect(findRow(folder)?.getAttribute("aria-expanded")).toBe("true");
    expect(scroller.scrollTop).toBe(0);

    await act(async () => pending.resolve([entry(first, false, true), entry(`${folder}/hidden.ts`, false, true)]));
    expect(findRow(first)?.getAttribute("aria-selected")).toBe("true");
    expect(findRow(first)?.getAttribute("aria-current")).toBe("true");
    expect(findRow(`${folder}/hidden.ts`)).toBeNull();
    expect(scroller.scrollTop).toBe(80);

    await show(other);
    expect(findRow(first)).toBeNull();
    expect(findRow(other)?.getAttribute("aria-current")).toBe("true");
    expect(findRow(other)?.getAttribute("aria-selected")).toBe("true");
    expect(scroller.scrollTop).toBe(60);

    await show(`${cwd}-sibling/elsewhere.ts`);
    expect(host.querySelector('[aria-current="true"]')).toBeNull();
    expect(findRow(other)?.getAttribute("aria-selected")).toBe("false");
    expect(scroller.scrollTop).toBe(60);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
