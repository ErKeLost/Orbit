import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listProviderAuth: vi.fn(), loginProvider: vi.fn(), providerLoginStatus: vi.fn(),
  cancelProviderLogin: vi.fn(async () => {}), answerProviderLogin: vi.fn(async () => {}),
  logoutProvider: vi.fn(async () => {}), report: vi.fn(), success: vi.fn(),
}));
vi.mock("../../lib/rpc", () => mocks);
vi.mock("../../shared/ui/toast", () => ({ toast: { success: mocks.success } }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
import { SubscriptionAccounts } from "./SubscriptionAccounts";

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  mocks.listProviderAuth.mockResolvedValue([{ id: "openai", name: "ChatGPT", configured: false, oauth: false }]);
  const session = { id: "login-1", provider: "openai", status: "running", prompt: { id: "prompt-1", prompt: { type: "manual_code", message: "Paste return URL" } } };
  mocks.loginProvider.mockResolvedValue(session);
  mocks.providerLoginStatus.mockResolvedValue(session);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear(); host.remove(); vi.unstubAllGlobals();
});
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); }
async function mount() {
  await act(async () => root.render(<StrictMode><QueryClientProvider client={client}><SubscriptionAccounts onChanged={() => {}} disabled={false} /></QueryClientProvider></StrictMode>));
  await flush();
}
async function click(label: string) {
  const button = Array.from(document.querySelectorAll("button")).find(button => button.textContent === label);
  expect(button).toBeTruthy();
  await act(async () => button!.click());
  await flush();
}

test("StrictMode keeps login alive, and closing releases the callback session", async () => {
  await mount(); await click("登录");
  expect(mocks.cancelProviderLogin).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Paste return URL");
  await click("取消登录");
  expect(mocks.cancelProviderLogin).toHaveBeenCalledWith("login-1");
});

test("navigation while login is starting cancels the eventual session", async () => {
  let finish: (value: unknown) => void;
  mocks.loginProvider.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await mount(); await click("登录");
  await act(async () => root.render(null));
  await act(async () => finish!({ id: "late-login", provider: "openai", status: "running" }));
  expect(mocks.cancelProviderLogin).toHaveBeenCalledWith("late-login");
});

test("the callback can win while a manual input is still on screen", async () => {
  await mount(); await click("登录");
  await act(async () => client.setQueryData(["provider-login", "login-1"], { id: "login-1", provider: "openai", status: "done" }));
  await flush();
  expect(document.body.textContent).toContain("账户已连接");
  expect(document.querySelector("#provider-login-answer")).toBeNull();
  expect(mocks.success).toHaveBeenCalledTimes(1);
});
