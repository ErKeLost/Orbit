// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Session } from "../../../lib/protocol";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
const renderSessionIcon = vi.hoisted(() => vi.fn(() => null));
vi.mock("../../../components/Icon", () => ({ Icon: renderSessionIcon }));
vi.mock("../../../lib/native", () => native);
vi.mock("../../../lib/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("../../../lib/runtime")>(),
  native: true,
  desktopRuntime: () => true,
}));
vi.mock("../chrome", () => ({ DevModeSlot: () => null, TabVisitNav: () => null, ResizeHandle: () => null, IS_MAC: false, MOD: "⌘" }));
vi.mock("./ProjectsSection", () => ({ ProjectsSection: () => null }));
vi.mock("./ProjectContextMenu", () => ({ ProjectContextMenu: () => null }));
vi.mock("./ProjectEditorDialog", () => ({ ProjectEditorDialog: () => null }));
vi.mock("./ProjectDirectoryPicker", () => ({ ProjectDirectoryPicker: () => null }));
vi.mock("../../settings/SettingsNav", () => ({ SettingsNav: () => null }));
vi.mock("../../../lib/desktop-update", () => ({ installDesktopUpdate: vi.fn(), useDesktopUpdate: () => null }));

import { ProjectRail } from "./ProjectRail";
import { queryClient, retireSession } from "../../../lib/rpc";
import { useWorkspace } from "../../../lib/store";
import { dayStart } from "../sessions/session-day";

const cwd = "/work/sidebar-project";
const makeSession = (name: string, day: number): Session => ({
  path: `/sessions/${name}.jsonl`, id: name, cwd, name,
  modified: new Date(dayStart(Date.now(), day)).toISOString(), firstMessage: "", messageCount: 1,
});
const recent = makeSession("Today", 0);
const old = makeSession("Yesterday", -1);
const listKey = ["pi", "sessions", cwd];
const onSearch = () => undefined;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  useWorkspace.getState().set({ cwd, homeDir: "", panel: "chat", runtimeTarget: "desktop", liveSessions: [] });
  queryClient.setQueryData(listKey, [recent, old]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  queryClient.clear();
  vi.unstubAllGlobals();
  native.invoke.mockReset();
  renderSessionIcon.mockClear();
});

const row = (session: Session) => host.querySelector(`[data-session-card="${session.path}"]`);

it("keeps surviving rows mounted and ignores a list refresh taken before deletion", async () => {
  let answer!: (sessions: Session[]) => void;
  native.invoke.mockImplementation((operation: string) => {
    if (operation === "list_sessions") return new Promise(resolve => { answer = resolve; });
    return Promise.resolve();
  });
  await act(async () => root.render(<QueryClientProvider client={queryClient}><ProjectRail visible onSearch={onSearch} /></QueryClientProvider>));
  expect(row(recent)).not.toBeNull();
  const survivingRow = row(old);
  expect(survivingRow).not.toBeNull();

  let refresh!: Promise<void>;
  await act(async () => { refresh = queryClient.refetchQueries({ queryKey: listKey }); });
  await act(async () => { await retireSession(recent.path); });
  await vi.waitFor(() => expect(queryClient.getQueryData(listKey)).toEqual([old]));
  await act(async () => { answer([recent, old]); await refresh; });
  await vi.waitFor(() => expect(row(recent)).toBeNull());
  expect(host.querySelector('section[aria-label="今天"]')).toBeNull();
  expect(host.querySelector('section[aria-label="昨天"]')).not.toBeNull();
  expect(row(old)).toBe(survivingRow);
});

it("does not rerender session rows for parent renders or streaming text", async () => {
  const render = (frame: number) => root.render(<QueryClientProvider client={queryClient}>
    <div data-parent-frame={frame}><ProjectRail visible onSearch={onSearch} /></div>
  </QueryClientProvider>);
  await act(async () => { render(0); });
  expect(renderSessionIcon).toHaveBeenCalled();
  renderSessionIcon.mockClear();
  await act(async () => {
    render(1);
    const state = useWorkspace.getState();
    state.set({ transcript: { ...state.transcript, error: "stream frame" } });
  });
  expect(renderSessionIcon).not.toHaveBeenCalled();
});
