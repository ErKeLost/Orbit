// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const commits = [
  { sha: "a".repeat(40), subject: "Fix the diff worker pool", author: "Nick" },
  { sha: "b".repeat(40), subject: "Searchable git history", author: "Ada" },
  { sha: "c".repeat(40), subject: "Slow transcript paint", author: "Nick" },
];

vi.mock("../../../platform/tauri/fs", () => ({
  gitHistory: vi.fn(async () => ({
    head: commits[0].sha,
    commits: commits.map((commit, index) => ({
      sha: commit.sha,
      shortSha: commit.sha.slice(0, 7),
      parents: [],
      author: commit.author,
      timestamp: 1_700_000_000 - index,
      subject: commit.subject,
      refs: index === 0 ? [{ name: "main", kind: "local" }] : [],
      head: index === 0,
    })),
  })),
  subscribeGitChanged: () => () => {},
}));

import { GitHistoryGraph } from "./GitHistoryGraph";

let container: HTMLDivElement;
let root: Root;
let opened: string[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  opened = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () =>
    root.render(
      createElement(GitHistoryGraph, {
        cwd: "/repo",
        enabled: true,
        expanded: true,
        onToggleExpanded: () => {},
        onOpenCommit: (commit: { sha: string }) => opened.push(commit.sha),
      }),
    ),
  );
  // 历史是异步取的：让 onResolve 落到 state 上。
  await act(async () => {});
}

function type(value: string) {
  const input = container.querySelector("input");
  if (!input) throw new Error("search input missing");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(key: string) {
  const input = container.querySelector("input");
  if (!input) throw new Error("search input missing");
  input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

function visibleShas() {
  return [...container.querySelectorAll("button[data-sha]")].map((row) =>
    row.getAttribute("data-sha"),
  );
}

describe("git history search", () => {
  it("lists the loaded commits and counts them in the header", async () => {
    await render();
    expect(visibleShas()).toEqual(commits.map((commit) => commit.sha));
    expect(container.textContent).toContain("3");
  });

  it("filters by subject, author and ref name", async () => {
    await render();
    await act(async () => type("worker"));
    expect(visibleShas()).toEqual([commits[0].sha]);
    expect(container.textContent).toContain("1/3");

    await act(async () => type("nick"));
    expect(visibleShas()).toEqual([commits[0].sha, commits[2].sha]);

    await act(async () => type("main"));
    expect(visibleShas()).toEqual([commits[0].sha]);
  });

  it("says so when nothing matches instead of showing an empty list", async () => {
    await render();
    await act(async () => type("nothing like this"));
    expect(visibleShas()).toEqual([]);
    expect(container.textContent).toContain("没有匹配");
  });

  it("opens the first match on Enter", async () => {
    await render();
    await act(async () => type("searchable"));
    await act(async () => press("Enter"));
    expect(opened).toEqual([commits[1].sha]);
  });

  it("moves the keyboard cursor before opening", async () => {
    await render();
    await act(async () => type("nick"));
    await act(async () => press("ArrowDown"));
    await act(async () => press("ArrowDown"));
    await act(async () => press("Enter"));
    expect(opened).toEqual([commits[2].sha]);
  });

  it("clears the query on Escape and keeps every row", async () => {
    await render();
    await act(async () => type("worker"));
    expect(visibleShas()).toHaveLength(1);
    await act(async () => press("Escape"));
    expect(visibleShas()).toEqual(commits.map((commit) => commit.sha));
  });

  it("opens a commit by clicking its row", async () => {
    await render();
    const row = container.querySelector(`button[data-sha="${commits[2].sha}"]`);
    await act(async () => row?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(opened).toEqual([commits[2].sha]);
  });
});
