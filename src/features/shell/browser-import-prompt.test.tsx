import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

const imports = vi.hoisted(() => ({ state: vi.fn(), sources: vi.fn(), run: vi.fn() }));
vi.mock("../../lib/browser-import", () => ({
  browserImportState: imports.state, browserImportSources: imports.sources,
  importBrowserSession: imports.run, importSummary: () => "已验证 Cookie",
  useBrowserImportStatus: () => ({ busy: false, revision: 0 }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => undefined }));
vi.mock("../../lib/persistent", () => ({ persistState: vi.fn() }));
const { BrowserImportPrompt } = await import("../browser/BrowserImportPrompt");
const { useWorkspace } = await import("../../lib/store");
const source = { browser: "Google Chrome", profile: "Default", label: "Default", path: "/profile", cookies: 25, account: null, running: false };
const mounted: { host: HTMLDivElement; root: ReturnType<typeof createRoot> }[] = [];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  localStorage.clear();
  useWorkspace.setState({ runtimeTarget: "desktop" });
  imports.state.mockReset().mockResolvedValue(null);
  imports.sources.mockReset().mockResolvedValue([source]);
  imports.run.mockReset();
});
afterEach(async () => {
  await act(async () => { for (const { host, root } of mounted.splice(0)) { root.unmount(); host.remove(); } });
});
async function mount(requested = false) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ host, root });
  await act(async () => root.render(<BrowserImportPrompt requested={requested} />));
  return host;
}
describe("browser login import offer", () => {
  test("a legacy dismissal does not hide the corrected production-store import", async () => {
    localStorage.setItem("orbit.browserImport.dismissed", "1");
    const host = await mount();
    expect(host.textContent).toContain("一键导入");
  });
  test("an import verified for the current native store suppresses the automatic offer", async () => {
    imports.state.mockResolvedValue({ ...source, version: 4 });
    const host = await mount();
    expect(host.textContent).toBe("");
    expect(imports.sources).not.toHaveBeenCalled();
  });
  test("the explicit toolbar entry can reimport even after success or dismissal", async () => {
    localStorage.setItem("orbit.browserImport.dismissed.v2", "1");
    imports.state.mockResolvedValue({ ...source, version: 4 });
    const host = await mount(true);
    expect(host.textContent).toContain("一键导入");
  });
  test("a failed import stays visible with its actionable reason", async () => {
    imports.run.mockRejectedValue(new Error("Keychain access denied"));
    const host = await mount();
    const button = [...host.querySelectorAll("button")].find(button => button.textContent === "一键导入")!;
    await act(async () => button.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Keychain access denied");
  });
});
