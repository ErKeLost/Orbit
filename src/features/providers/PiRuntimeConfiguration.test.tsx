import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPiRuntimeSettings: vi.fn(), savePiRuntimeSettings: vi.fn(), probePiRuntime: vi.fn(),
  connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), report: vi.fn(), success: vi.fn(),
  workspace: { connection: "online", transcript: { running: false }, cwd: "/project" },
}));
vi.mock("../../lib/rpc", () => mocks);
vi.mock("../../shared/ui/toast", () => ({ toast: { success: mocks.success } }));
vi.mock("../../lib/store", () => ({ useWorkspace: Object.assign((select: (value: unknown) => unknown) => select(mocks.workspace), { getState: () => mocks.workspace }) }));
import { PiRuntimeConfiguration } from "./PiRuntimeConfiguration";

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const stored = { driver: "pi", environment: "local", config: { binaryPath: "", launchArgs: "--thinking high", environment: [{ name: "OPENAI_API_KEY", value: "", sensitive: true, valueRedacted: true }] } };
  mocks.getPiRuntimeSettings.mockResolvedValue(stored);
  mocks.savePiRuntimeSettings.mockResolvedValue(stored);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear(); host.remove(); vi.unstubAllGlobals();
});
async function mount() {
  await act(async () => root.render(<QueryClientProvider client={client}><PiRuntimeConfiguration onSaved={() => {}} /></QueryClientProvider>));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
}
async function click(label: string) {
  const button = Array.from(host.querySelectorAll("button")).find(button => button.textContent === label);
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}

test("an unchanged redacted secret survives saving without becoming an empty replacement", async () => {
  await mount();
  const value = host.querySelector<HTMLInputElement>('[aria-label="环境变量值 1"]')!;
  expect(value.value).toBe("");
  expect(value.type).toBe("password");
  expect(host.querySelector<HTMLInputElement>('[aria-label="环境变量名 1"]')!.disabled).toBe(true);
  await click("保存");
  expect(mocks.savePiRuntimeSettings.mock.calls[0][0].environment).toEqual([{ name: "OPENAI_API_KEY", value: "", sensitive: true, valueRedacted: true }]);
  expect(mocks.disconnect).not.toHaveBeenCalled();
});

test("save and reconnect applies to the current local workspace", async () => {
  await mount(); await click("保存并重连");
  expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  expect(mocks.connect).toHaveBeenCalledWith("/project");
});
