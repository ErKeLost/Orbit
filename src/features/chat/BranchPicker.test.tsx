import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { useWorkspace } from "../../lib/store";
import { BranchPicker } from "./BranchPicker";

const git = vi.hoisted(() => ({
  gitCheckout: vi.fn().mockResolvedValue(undefined),
  gitCreateBranch: vi.fn().mockResolvedValue(undefined),
  useGitBranches: () => ({ data: { branches: [
    { name: "main", current: true },
    { name: "feature", current: false },
  ] } }),
}));
vi.mock("../../lib/git", () => git);
vi.mock("../../lib/rpc", () => ({ queryClient: { invalidateQueries: vi.fn() } }));

test("allows browsing branches while running and prevents checkout or creation by mouse and keyboard", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const idle = useWorkspace.getState().transcript;
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    useWorkspace.setState({ transcript: { ...idle, running: true } });
    await act(async () => root.render(<BranchPicker cwd="/repo" current="main" />));
    await act(async () => host.querySelector("button")!.click());
    const dialog = document.querySelector('[role="dialog"][aria-label="分支"]')!;
    const search = dialog.querySelector("input")!;
    const feature = dialog.querySelector<HTMLButtonElement>('button[role="option"][aria-selected="false"]')!;
    expect(feature.textContent).toBe("feature");
    expect(feature.disabled).toBe(true);
    await act(async () => feature.click());
    const searchFor = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, value);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const enter = async () => act(async () => {
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await searchFor("feature");
    expect(dialog.querySelectorAll('[role="option"]')).toHaveLength(1);
    await enter();
    expect(git.gitCheckout).not.toHaveBeenCalled();

    await searchFor("new-branch");
    expect(dialog.textContent).toContain("没有匹配的分支");
    expect(dialog.textContent).not.toContain("创建分支 new-branch");
    await enter();
    expect(git.gitCreateBranch).not.toHaveBeenCalled();

    await act(async () => useWorkspace.setState({ transcript: idle }));
    expect(dialog.textContent).toContain("创建分支 new-branch");
    await searchFor("feature");
    await enter();
    expect(git.gitCheckout).toHaveBeenCalledWith("/repo", "feature", undefined);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    useWorkspace.setState({ transcript: idle });
    vi.unstubAllGlobals();
  }
});
