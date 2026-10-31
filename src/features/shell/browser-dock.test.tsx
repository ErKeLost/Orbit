import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

// The column's page is a native view, which does not exist here: the dock's own
// behaviour (tab strip, address bar, close) is what this covers.
const nativeCall = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ open: true, url: "", visible: true, loading: false })));
const contextMenu = vi.hoisted(() => ({
  create: vi.fn(), popup: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/menu", () => ({ Menu: { new: contextMenu.create } }));
vi.mock("../../lib/native", () => ({ invoke: nativeCall }));
// The page's own channels (import progress, native view events) are desktop-only.
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => undefined }));

const { BrowserDock } = await import("../browser/BrowserDock");
const { newWorkspaceTab, useShell } = await import("./shellStore");
const mounted: { host: HTMLDivElement; root: ReturnType<typeof createRoot> }[] = [];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  await act(async () => { for (const { root, host } of mounted.splice(0)) { root.unmount(); host.remove(); } });
});

beforeEach(() => {
  contextMenu.create.mockReset();
  contextMenu.popup.mockClear();
  contextMenu.close.mockClear();
  contextMenu.create.mockResolvedValue({ popup: contextMenu.popup, close: contextMenu.close });
  const workspace = newWorkspaceTab("/repo", "c1");
  useShell.setState({
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
    activeByProject: {},
    browserTabs: [],
    browserActive: null,
    browserOpen: false,
    browserPip: null,
  });
});

async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ host, root });
  await act(async () => {
    root.render(<BrowserDock />);
  });
  return host;
}

describe("the browser column", () => {
  async function openMenu(index: number) {
    const host = await mount();
    let paths: string[] = [];
    await act(async () => { paths = ["a", "b", "c"].map(name => useShell.getState().openBrowser(`https://${name}.example`)); });
    await act(async () => { host.querySelectorAll('[role="tab"]')[index].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 80 })); });
    const items = contextMenu.create.mock.calls.at(-1)![0].items as { id: string; enabled?: boolean; action: () => void }[];
    return { host, paths, item: (id: string) => items.find(item => item.id === id)! };
  }

  test("right-clicking a background tab uses a native menu and keeps the selected tab", async () => {
    const { paths } = await openMenu(0);
    expect(useShell.getState().browserActive).toBe(paths[2]);
    expect(contextMenu.popup).toHaveBeenCalledWith(expect.objectContaining({ x: 100, y: 80 }));
    expect(contextMenu.close).toHaveBeenCalledOnce();
    expect(contextMenu.create.mock.calls[0][0].items.map((item: {id:string}) => item.id)).toEqual(["toggle-mute", "close", "close-others", "close-to-right", "close-all"]);
  });

  test("close others keeps the clicked background tab and clears a closed PiP in one update", async () => {
    const { paths, item } = await openMenu(1);
    await act(async () => useShell.getState().toggleBrowserPip(paths[2]));
    const changed = vi.fn();
    const unsubscribe = useShell.subscribe(changed);
    await act(async () => item("close-others").action());
    unsubscribe();
    expect(changed).toHaveBeenCalledOnce();
    expect(useShell.getState().browserTabs.map(tab => tab.path)).toEqual([paths[1]]);
    expect(useShell.getState().browserActive).toBe(paths[1]);
    expect(useShell.getState().browserPip).toBeNull();
  });

  test("close right is relative to the clicked tab and preserves an unrelated PiP", async () => {
    const { paths, item } = await openMenu(1);
    await act(async () => useShell.getState().toggleBrowserPip(paths[0]));
    await act(async () => useShell.getState().setBrowserActive(paths[2]));
    await act(async () => item("close-to-right").action());
    expect(useShell.getState().browserTabs.map(tab => tab.path)).toEqual(paths.slice(0, 2));
    expect(useShell.getState().browserActive).toBe(paths[1]);
    expect(useShell.getState().browserPip?.tab).toBe(paths[0]);
  });

  test("close all clears the native tab list and closes the dock", async () => {
    const { item } = await openMenu(1);
    await act(async () => item("close-all").action());
    expect(useShell.getState().browserTabs).toEqual([]);
    expect(useShell.getState().browserActive).toBeNull();
    expect(useShell.getState().browserOpen).toBe(false);
  });

  test("close right is disabled on the rightmost tab", async () => {
    const { item } = await openMenu(2);
    expect(item("close-to-right").enabled).toBe(false);
  });

  test("middle-click closes the tab under the pointer", async () => {
    const { host, paths } = await openMenu(0);
    await act(async () => host.querySelectorAll('[role="tab"]')[1].dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true })));
    expect(useShell.getState().browserTabs.map(tab => tab.path)).toEqual([paths[0], paths[2]]);
    expect(useShell.getState().browserActive).toBe(paths[2]);
  });
  test("opening an agent's blank tab creates a native view before a website is chosen", async () => {
    const box = { x:100, y:100, width:520, height:600, top:100, left:100, right:620, bottom:700, toJSON:()=>({}) };
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(box as DOMRect);
    nativeCall.mockClear();
    await mount();
    await act(async () => { useShell.getState().openBrowser("", {path:"browser:blank-agent"}); });
    await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
    expect(nativeCall).toHaveBeenCalledWith("browser_view_sync", expect.objectContaining({tab:"browser:blank-agent",visible:true}));
    bounds.mockRestore();
  });
  test("stays hidden until opened, and keeps its pages when collapsed", async () => {
    const host = await mount();
    const dock = host.querySelector("[data-browser-dock]") as HTMLElement & { hidden: boolean };
    expect(dock.hidden).toBe(true);

    await act(async () => {
      useShell.getState().openBrowser("https://example.com/a");
    });
    expect(dock.hidden).toBe(false);
    expect(host.textContent).toContain("example.com");
    // A page always has its address bar.
    expect(host.querySelector("input[data-browser-address]")).not.toBeNull();

    await act(async () => {
      useShell.getState().setBrowserOpen(false);
    });
    // Collapsing is not closing: the tab is still there, hidden with the column.
    expect(dock.hidden).toBe(true);
    expect(useShell.getState().browserTabs).toHaveLength(1);
  });

  test("closing the last page closes the column, not just its tab", async () => {
    const host = await mount();
    let path = "";
    await act(async () => {
      path = useShell.getState().openBrowser("https://example.com/a");
    });
    const closeButton = [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label")?.startsWith("关闭 "))!;
    await act(async () => {
      closeButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(useShell.getState().browserTabs).toHaveLength(0);
    expect(useShell.getState().browserOpen).toBe(false);
    expect(path).not.toBe("");
  });

  test("a run's tab at a sign-in wall becomes the reader's tab instead of vanishing", async () => {
    await mount();
    let path = "";
    await act(async () => {
      path = useShell.getState().openBrowser("https://account.example.com/login", { path: "browser:run1" });
    });
    expect(useShell.getState().browserTabs[0].agent).toBe(true);

    // The run ends where only the person can go on, so the app hands it over.
    await act(async () => {
      useShell.getState().adoptBrowser(path, "https://account.example.com/login");
    });

    const tab = useShell.getState().browserTabs.find((item) => item.path === path)!;
    expect(tab.agent).toBeUndefined();
    expect(tab.handoff).toBe(true);
    expect(useShell.getState().browserActive).toBe(path);
    expect(useShell.getState().browserOpen).toBe(true);
    // It is the reader's now: a link lands in it instead of opening a second page.
    expect(useShell.getState().openLink("https://example.com/next")).toBe(path);
  });

  test("a later handoff preserves the earlier site's page", async () => {
    await mount();
    let first = "";
    let second = "";
    await act(async () => {
      first = useShell.getState().openBrowser("https://a.example/login", { path: "browser:run1" });
      second = useShell.getState().openBrowser("https://b.example/pay", { path: "browser:run2" });
    });
    await act(async () => {
      useShell.getState().adoptBrowser(first);
    });
    await act(async () => {
      useShell.getState().adoptBrowser(second);
    });
    expect(useShell.getState().browserTabs.map((tab) => tab.path)).toEqual([first, second]);
  });
});
