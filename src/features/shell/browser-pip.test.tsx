import { beforeEach, describe, expect, test, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

// The floating page is a native view placed at a rectangle, so the rectangle it
// asks for is the whole contract this test can check (`browser_view_sync`).
const sync = vi.fn(async () => ({ open: true, url: "", visible: true, loading: false }));
vi.mock("../../lib/native", () => ({
  invoke: async (...args: unknown[]) => (sync as unknown as (...a: unknown[]) => Promise<unknown>)(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => undefined }));
vi.mock("../../lib/browser-view", async () => {
  const actual = await vi.importActual<typeof import("../../lib/browser-view")>("../../lib/browser-view");
  return {
    ...actual,
    syncBrowserView: (tab: string, rect: unknown, url?: string, visible?: boolean) =>
      sync(tab, rect, url, visible) as Promise<{ open: boolean; url: string; visible: boolean; loading: boolean }>,
  };
});

const { BrowserPip } = await import("../browser/BrowserPip");
const { BrowserDock } = await import("../browser/BrowserDock");
const { newWorkspaceTab, useShell } = await import("./shellStore");

function reset() {
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
  sync.mockClear();
}

beforeEach(reset);

async function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
  });
  return host;
}

describe("画中画", () => {
  test("浮起来的还是那一页，不是第二个标签", async () => {
    await render(<BrowserDock />);
    let path = "";
    await act(async () => {
      path = useShell.getState().openBrowser("https://example.com/a");
    });

    await act(async () => {
      useShell.getState().toggleBrowserPip(path);
    });

    // 浮起来没有多出一页：视图只有一个，位置也只有一个。
    expect(useShell.getState().browserTabs).toHaveLength(1);
    expect(useShell.getState().browserPip?.tab).toBe(path);
    // 浮着的页就是 agent 的通道默认要说话的那一页。
    expect(useShell.getState().browserActive).toBe(path);
  });

  test("再点一次就收回列里，页面还在", async () => {
    await render(<BrowserDock />);
    let path = "";
    await act(async () => {
      path = useShell.getState().openBrowser("https://example.com/a");
    });
    await act(async () => {
      useShell.getState().toggleBrowserPip(path);
    });
    await act(async () => {
      useShell.getState().toggleBrowserPip(path);
    });

    expect(useShell.getState().browserPip).toBeNull();
    expect(useShell.getState().browserTabs.map((tab) => tab.path)).toEqual([path]);
  });

  test("浮起来时把视图摆到卡片的矩形上", async () => {
    let path = "";
    await act(async () => {
      path = useShell.getState().openBrowser("https://example.com/a");
    });
    // 卡片的空地要有尺寸，否则原生视图没有可摆的地方。
    const box = { x: 100, y: 200, width: 420, height: 300, top: 200, left: 100, right: 520, bottom: 500, toJSON: () => ({}) };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(box as DOMRect);

    await act(async () => {
      useShell.getState().toggleBrowserPip(path);
      await render(<BrowserPip />);
      await Promise.resolve();
    });

    // `sync(tab, rect, url, visible)`：最后一个调用就是刚才摆的那一下。
    const last = sync.mock.calls.at(-1) as unknown as [string, { x: number; y: number; width: number; height: number }];
    expect(last[0]).toBe(path);
    expect(last[1]).toMatchObject({ x: 100, y: 200, width: 420, height: 300 });
  });

  test("关掉浮窗就没了，页面也一起关", async () => {
    let path = "";
    await act(async () => {
      path = useShell.getState().openBrowser("https://example.com/a");
    });
    await act(async () => {
      useShell.getState().toggleBrowserPip(path);
    });
    const host = await render(<BrowserPip />);
    const close = [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "关闭这一页")!;

    await act(async () => {
      close.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(useShell.getState().browserPip).toBeNull();
    expect(useShell.getState().browserTabs).toHaveLength(0);
  });

  test("不同网站交接时保留先前打开的浏览器页", async () => {
    const first = useShell.getState().openBrowser("https://one.example/login", { path: "browser:one" });
    useShell.getState().adoptBrowser(first, "https://one.example/login");
    const second = useShell.getState().openBrowser("https://two.example/dashboard", { path: "browser:two" });
    useShell.getState().adoptBrowser(second, "https://two.example/dashboard");
    expect(useShell.getState().browserTabs.map(tab=>tab.path)).toEqual(["browser:one","browser:two"]);
    expect(useShell.getState().browserActive).toBe("browser:two");
  });
  test("后台任务释放页面不会抢焦点；用户关闭浮页同时清理画中画", async () => {
    const first=useShell.getState().openBrowser("https://one.example",{path:"browser:first"});
    const second=useShell.getState().openBrowser("https://two.example");
    useShell.getState().releaseBrowser(first);
    expect(useShell.getState().browserActive).toBe(second);
    expect(useShell.getState().browserTabs[0].agent).toBeUndefined();
    useShell.getState().toggleBrowserPip(first);
    useShell.getState().closeFile(first);
    expect(useShell.getState().browserPip).toBeNull();
    expect(useShell.getState().browserTabs.map(tab=>tab.path)).toEqual([second]);
  });

  test("拖动记住位置：下次弹出还在原处", async () => {
    let path = "";
    await act(async () => {
      path = useShell.getState().openBrowser("https://example.com/a");
    });
    await act(async () => {
      useShell.getState().toggleBrowserPip(path);
    });
    await act(async () => {
      useShell.getState().moveBrowserPip({ x: 12, y: 34 });
    });
    await act(async () => {
      useShell.getState().dockBrowserPip();
    });
    await act(async () => {
      useShell.getState().toggleBrowserPip(path);
    });

    expect(useShell.getState().browserPip).toMatchObject({ x: 12, y: 34 });
  });
});
