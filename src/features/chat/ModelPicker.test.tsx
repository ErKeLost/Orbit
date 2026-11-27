import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { RpcSessionState } from "../../lib/protocol";
import { useWorkspace } from "../../lib/store";
import { ModelPicker } from "./ModelPicker";

const rpc = vi.hoisted(() => ({
  request: vi.fn(), refresh: vi.fn(), getModelEffort: vi.fn(), probeModelEffort: vi.fn(),
  expectModel: vi.fn(), settleModel: vi.fn(), report: vi.fn(), persistDefaultModel: vi.fn(),
}));
vi.mock("../../lib/rpc", () => rpc);
vi.mock("../../components/ModelMeta", () => ({ ModelLogo: () => null }));

const model = {
  id: "test-model", name: "Test Model", provider: "fixture", api: "openai-responses", baseUrl: "https://fixture.test/v1",
  contextWindow: 128000, maxTokens: 8192, reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies NonNullable<RpcSessionState["model"]>;
const otherModel = { ...model, id: "other-model", name: "Other Model" };
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let session: RpcSessionState;
let levels: NonNullable<RpcSessionState["thinkingLevel"]>[];
type Command = { type: string; level?: RpcSessionState["thinkingLevel"]; message?: string; modelId?: string };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  session = {
    model, sessionId: "session-1", thinkingLevel: "off", isStreaming: false, isCompacting: false,
    steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", autoCompactionEnabled: false,
    messageCount: 0, pendingMessageCount: 0,
  };
  levels = ["off"];
  useWorkspace.setState({ state: session, connection: "online", connectionId: "connection-1", runtimeTarget: "desktop" });
  rpc.refresh.mockImplementation(async () => {
    useWorkspace.setState({ state: session });
    return session;
  });
  rpc.request.mockImplementation(async (command: Command) => {
    switch (command.type) {
      case "get_available_models": return { models: [model, otherModel] };
      case "set_model":
        expect(command.modelId).toBe(otherModel.id);
        session = { ...session, model: otherModel };
        return;
      case "get_available_thinking_levels": return { levels };
      case "get_commands": return { commands: [{ name: "gui-effort-apply", source: "extension" }] };
      case "get_state": return session;
      case "prompt":
        expect(command.message).toMatch(/^\/gui-effort-apply /);
        levels = ["low", "high", "max"];
        session = { ...session, thinkingLevel: "low" };
        return { disposition: "handled" };
      case "set_thinking_level":
        session = { ...session, thinkingLevel: command.level };
        return;
      default: throw new Error(`Unexpected RPC ${command.type}`);
    }
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  useWorkspace.setState({ state: null, connection: "offline", connectionId: "", runtimeTarget: "unknown", transcript: useWorkspace.getInitialState().transcript });
  vi.unstubAllGlobals();
});

function slider() {
  return document.querySelector<HTMLInputElement>('input[type="range"][aria-label="Effort"]');
}

function expectNoEffortButtons() {
  expect(document.querySelector(".composer-effort-footer")).not.toBeNull();
  expect(document.querySelector(".composer-effort-footer button")).toBeNull();
}

async function togglePicker() {
  await act(async () => host.querySelector<HTMLButtonElement>("[data-model-control]")!.click());
}

async function openPicker() {
  await act(async () => root.render(<QueryClientProvider client={client}><ModelPicker /></QueryClientProvider>));
  expect(rpc.getModelEffort).not.toHaveBeenCalled();
  await togglePicker();
}

async function waitForPicker(assert: () => void) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    assert();
  });
}

async function waitForSlider(value: string) {
  await waitForPicker(() => {
    expect(slider()?.disabled).toBe(false);
    expect(slider()?.getAttribute("aria-valuetext")).toBe(value);
  });
}

test.each(["submitted", "running", "compacting"] as const)("keeps the model menu searchable but read-only while %s", async (phase) => {
  const idle = useWorkspace.getState().transcript;
  useWorkspace.setState({ transcript: { ...idle, [phase]: true } });
  rpc.getModelEffort.mockResolvedValue({ eligible: false });
  await openPicker();
  await waitForPicker(() => expect(document.querySelectorAll(".composer-model-row")).toHaveLength(2));
  expect(rpc.getModelEffort).not.toHaveBeenCalled();
  expect(document.querySelector('[role="status"]')?.textContent).toContain("暂不可切换模型");

  const search = document.querySelector<HTMLInputElement>('input[placeholder="搜索模型"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "other");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const rows = document.querySelectorAll<HTMLButtonElement>(".composer-model-row");
  expect(rows).toHaveLength(1);
  const row = rows[0];
  expect(row.disabled).toBe(true);
  await act(async () => row.click());
  expect(rpc.request).not.toHaveBeenCalledWith(expect.objectContaining({ type: "set_model" }), 30000, "connection-1");

  await act(async () => useWorkspace.setState({ transcript: idle }));
  expect(row.disabled).toBe(false);
  await act(async () => row.click());
  expect(rpc.request).toHaveBeenCalledWith({ type: "set_model", provider: otherModel.provider, modelId: otherModel.id }, 30000, "connection-1");
});

test("locks the effort slider when a turn starts with the menu open", async () => {
  levels = ["off", "low", "high"];
  rpc.getModelEffort.mockResolvedValue({ eligible: false });
  await openPicker();
  await waitForSlider("Off");
  await act(async () => useWorkspace.setState(({ transcript }) => ({ transcript: { ...transcript, running: true } })));
  expect(slider()?.disabled).toBe(true);
  await act(async () => slider()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(rpc.request).not.toHaveBeenCalledWith(expect.objectContaining({ type: "set_thinking_level" }), 30000, "connection-1");
});

test("reads cached levels on open and applies the slider's selected level to the session", async () => {
  rpc.getModelEffort.mockResolvedValue({ eligible: true, levels: ["low", "high", "max"] });
  await openPicker();
  await waitForSlider("Low");
  expect(slider()?.max).toBe("2");
  expectNoEffortButtons();
  expect(rpc.getModelEffort).toHaveBeenCalledExactlyOnceWith(model);
  expect(rpc.probeModelEffort).not.toHaveBeenCalled();
  expect(rpc.request).toHaveBeenCalledWith(expect.objectContaining({ type: "prompt" }), 30000, "connection-1");

  const track = document.querySelector<HTMLElement>(".effort-slider-track")!;
  vi.spyOn(track, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 240, 24));
  const range = slider()!;
  await act(async () => {
    range.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 16, bubbles: true }));
    range.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 224, bubbles: true }));
    range.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 224, bubbles: true }));
  });
  await waitForSlider("Max");
  expect(rpc.request).toHaveBeenCalledWith({ type: "set_thinking_level", level: "max" }, 30000, "connection-1");
  expect(document.querySelector(".effort-slider[data-galaxy]")).not.toBeNull();
});

test("automatically probes on a cache miss and reuses the result on later opens", async () => {
  const discovery = { eligible: true, levels: ["low", "high", "max"] };
  rpc.getModelEffort.mockResolvedValueOnce({ eligible: true }).mockResolvedValue(discovery);
  rpc.probeModelEffort.mockResolvedValue(discovery);
  await openPicker();
  await waitForSlider("Low");
  expectNoEffortButtons();

  await togglePicker();
  expect(slider()).toBeNull();
  await togglePicker();
  await waitForSlider("Low");
  expect(rpc.getModelEffort).toHaveBeenCalledTimes(2);
  expect(rpc.probeModelEffort).toHaveBeenCalledExactlyOnceWith(model);
});

test("shows a discovery failure and automatically retries on reopening", async () => {
  rpc.getModelEffort.mockResolvedValue({ eligible: true });
  rpc.probeModelEffort.mockRejectedValueOnce(new Error("Effort 查询失败（HTTP 429）"))
    .mockResolvedValueOnce({ eligible: true, levels: ["low", "high", "max"] });
  await openPicker();
  await waitForPicker(() => {
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Effort 查询失败（HTTP 429）");
  });
  expectNoEffortButtons();

  await togglePicker();
  await togglePicker();
  await waitForSlider("Low");
  expect(rpc.probeModelEffort).toHaveBeenCalledTimes(2);
});

test("uses Pi's supported levels as slider stops when discovery is unavailable", async () => {
  levels = ["off", "minimal", "xhigh"];
  rpc.getModelEffort.mockResolvedValue({ eligible: false });
  await openPicker();
  await waitForSlider("Off");
  expect(slider()?.max).toBe("2");
  await act(async () => slider()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  await waitForSlider("Minimal");
  await act(async () => slider()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  await waitForSlider("XHigh");
  expect(rpc.request).not.toHaveBeenCalledWith(expect.objectContaining({ type: "prompt" }), expect.any(Number), expect.any(String));
});
