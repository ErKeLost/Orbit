import { beforeEach, describe, expect, test, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

// The column's page is a native view, which does not exist here: the dock's own
// behaviour (tab strip, address bar, close) is what this covers.
vi.mock("../../lib/native", () => ({ invoke: async () => ({ open: true, url: "", visible: true, loading: false }) }));
// The page's own channels (import progress, native view events) are desktop-only.
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => undefined }));

const { BrowserDock } = await import("../browser/BrowserDock");
const { newWorkspaceTab, useShell } = await import("./shellStore");

beforeEach(() => {
  const workspace = newWorkspaceTab("/repo", "c1");
  useShell.setState({
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
    activeByProject: {},
    browserTabs: [],
    browserActive: null,
    browserOpen: false,
  });
});

async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<BrowserDock />);
  });
  return host;
}

describe("the browser column", () => {
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

  test("only one handed-over page is kept", async () => {
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
    // A takeover surface is not a log: the older wall goes as the newer arrives.
    expect(useShell.getState().browserTabs.map((tab) => tab.path)).toEqual([second]);
  });
});
