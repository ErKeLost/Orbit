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
vi.mock("../../components/chat/EffortSlider", () => ({ EffortSlider: () => null }));

const model = {
  id: "test-model", name: "Test Model", provider: "fixture", api: "openai-responses", baseUrl: "https://fixture.test/v1",
  contextWindow: 128000, maxTokens: 8192, reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies NonNullable<RpcSessionState["model"]>;
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let session: RpcSessionState;
let levels: NonNullable<RpcSessionState["thinkingLevel"]>[];
type Command = { type: string; level?: RpcSessionState["thinkingLevel"]; message?: string };

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
      case "get_available_models": return { models: [model] };
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
  useWorkspace.setState({ state: null, connection: "offline", connectionId: "", runtimeTarget: "unknown" });
  vi.unstubAllGlobals();
});

function option(label: string) {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.composer-effort-options button'))
    .find(button => button.textContent === label);
}

async function openPicker() {
  await act(async () => root.render(<QueryClientProvider client={client}><ModelPicker /></QueryClientProvider>));
  await act(async () => host.querySelector<HTMLButtonElement>("[data-model-control]")!.click());
}

async function waitForOption(label: string) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(option(label)?.disabled).toBe(false);
  });
}

test("shows and applies cached levels automatically, then lets the user pick a supported level", async () => {
  rpc.getModelEffort.mockResolvedValue({ eligible: true, levels: ["low", "high", "max"] });
  await openPicker();
  await waitForOption("Max");
  expect(option("Off")).toBeUndefined();
  expect(option("Medium")).toBeUndefined();
  expect(option("Low")?.getAttribute("aria-pressed")).toBe("true");
  expect(rpc.probeModelEffort).not.toHaveBeenCalled();
  expect(rpc.request).toHaveBeenCalledWith(expect.objectContaining({ type: "prompt" }), 30000, "connection-1");
  await act(async () => option("Max")!.click());
  await waitForOption("Max");
  expect(option("Max")?.getAttribute("aria-pressed")).toBe("true");
});

test("shows newly queried levels without an extra apply step", async () => {
  rpc.getModelEffort.mockResolvedValue({ eligible: true });
  rpc.probeModelEffort.mockResolvedValue({ eligible: true, levels: ["low", "high", "max"] });
  await openPicker();
  const probeButton = () => Array.from(document.querySelectorAll("button")).find(button => button.textContent === "查询档位");
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(probeButton()?.disabled).toBe(false);
  });
  await act(async () => probeButton()!.click());
  await waitForOption("Max");
  expect(rpc.probeModelEffort).toHaveBeenCalledWith(model);
  expect(document.body.textContent).not.toContain("应用缓存");
});

test("lists Pi's available levels without a discovery cache", async () => {
  levels = ["off", "minimal", "xhigh"];
  rpc.getModelEffort.mockResolvedValue({ eligible: false });
  await openPicker();
  await waitForOption("XHigh");
  expect(option("Off")?.getAttribute("aria-pressed")).toBe("true");
  expect(option("Minimal")).toBeDefined();
  expect(option("High")).toBeUndefined();
  expect(rpc.request).not.toHaveBeenCalledWith(expect.objectContaining({ type: "prompt" }), expect.any(Number), expect.any(String));
});
