import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentActivityFeed } from "../src/components/agents/AgentActivityFeed";
import { agentIcon } from "../src/components/agents/agent-icon";
import type { AgentNode, AgentSnapshot } from "../src/lib/agents";

function worker(overrides: Partial<AgentNode> = {}): AgentNode {
  return { id: "w", parentId: "root", name: "worker", task: "", status: "running", childrenIds: [], children: [], ...overrides };
}

const snapshot: AgentSnapshot = {
  version: 1,
  rootId: "root",
  active: [{ id: "active", parentId: "root", name: "Repo integration", task: "检查代码结构", status: "running", startedAt: Date.now(), childrenIds: [], children: [] }],
  recent: [{ id: "done", parentId: "root", name: "Pi latest", task: "核对版本", status: "completed", startedAt: Date.now() - 2_000, endedAt: Date.now(), childrenIds: [], children: [] }],
  updatedAt: Date.now(),
};

describe("agent activity feed", () => {
  test("renders active and completed workers as lightweight timeline rows", () => {
    const html = renderToStaticMarkup(<AgentActivityFeed snapshot={snapshot} />);
    expect(html).toContain("子 agent 活动");
    expect(html).toContain("Repo integration");
    expect(html).toContain("Pi latest");
    expect(html).toContain("agent-feed-line");
    expect(html).not.toContain("已开启 · 2");
  });

  test("does not render an empty snapshot", () => {
    const html = renderToStaticMarkup(<AgentActivityFeed snapshot={{ ...snapshot, active: [], recent: [] }} />);
    expect(html).toBe("");
  });

  test("lets a running worker be opened, not just a finished one", () => {
    // Following a sub-agent while it works is the point of the feed: the tab is
    // opened from the worker's session file, which exists after its first entry.
    const html = renderToStaticMarkup(<AgentActivityFeed snapshot={{ ...snapshot, active: [{ ...snapshot.active[0], sessionPath: "/tmp/subagents/a/session.jsonl" }] }} />);
    expect(html).toContain("<button");
    expect(html).toContain("打开子会话");
  });

  test("explains why a worker with no session file cannot be opened", () => {
    const html = renderToStaticMarkup(<AgentActivityFeed snapshot={{ ...snapshot, active: [], recent: [{ id: "gone", parentId: "root", name: "perf_audit_chat", task: "", status: "failed", startedAt: Date.now(), endedAt: Date.now(), error: "No API key found", childrenIds: [], children: [] }] }} />);
    expect(html).not.toContain("<button");
    expect(html).toContain("子会话没有落盘");
  });

  test("marks status on the avatar without replacing the logo", () => {
    const rows: AgentSnapshot = { ...snapshot, active: [worker({ id: "a", name: "repo_scan", logo: "search-sparkle-24" })] };
    const html = renderToStaticMarkup(<AgentActivityFeed snapshot={rows} />);
    expect(html).toContain("agent-feed-badge");
    expect(html).toContain('data-logo="search-sparkle-24"');
    expect(html).toContain("agent-feed-avatar is-running");
  });
});

describe("agent avatars", () => {
  // 图标是模型写的，不是查表查出来的：代码只补前缀、只兜底。
  test("uses the logo the model gave, bare or fully qualified", () => {
    expect(agentIcon(worker({ logo: "shield-checkmark-24" }))).toBe("fluent-color:shield-checkmark-24");
    expect(agentIcon(worker({ logo: "flat-color-icons:search" }))).toBe("flat-color-icons:search");
    expect(agentIcon(worker({ logo: "  image-24  " }))).toBe("fluent-color:image-24");
  });

  test("the logo wins over the status glyph", () => {
    for (const status of ["running", "completed", "failed"] as const) {
      expect(agentIcon(worker({ logo: "bug-24", status }))).toBe("fluent-color:bug-24");
    }
  });

  test("falls back to a status glyph, then to a neutral one", () => {
    expect(agentIcon(worker({ status: "completed" }))).toBe("fluent-color:checkmark-circle-24");
    expect(agentIcon(worker({ status: "failed" }))).toBe("fluent-color:error-circle-24");
    expect(agentIcon(worker({ status: "queued" }))).toBe("fluent-color:clock-24");
    // 跑着的 worker 没有 logo 时不能说谎说它完成了。
    expect(agentIcon(worker({ status: "running" }))).toBe("fluent-color:lightbulb-24");
  });
});
