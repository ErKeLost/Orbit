import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentActivityFeed } from "../src/components/agents/AgentActivityFeed";
import { agentIcon, agentKind } from "../src/components/agents/agent-kind";
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

  test("marks status on the avatar without replacing the kind glyph", () => {
    const rows: AgentSnapshot = { ...snapshot, active: [worker({ id: "a", name: "repo_scan", task: "调研竞品" })] };
    const html = renderToStaticMarkup(<AgentActivityFeed snapshot={rows} />);
    expect(html).toContain("agent-feed-badge");
    expect(html).toContain("data-kind=\"search\"");
    expect(html).toContain("agent-feed-avatar is-running");
  });
});

describe("agent avatars", () => {
  test("picks a kind from the task, not just the name", () => {
    expect(agentKind(worker({ name: "catalog_tokens", task: "统计 token 数量" }))).toBe("data");
    expect(agentKind(worker({ name: "worker", task: "用 git 整理提交历史" }))).toBe("vcs");
    expect(agentKind(worker({ name: "worker", task: "写一份发布公告" }))).toBe("release");
    expect(agentKind(worker({ name: "worker", task: "画一张封面插画" }))).toBe("image");
  });

  test("gives different workers different glyphs", () => {
    const icons = [
      worker({ name: "repo_scan", task: "检查代码结构" }),
      worker({ name: "token_count", task: "统计数据" }),
      worker({ name: "writer", task: "撰写总结" }),
      worker({ name: "shell", task: "运行 bash" }),
    ].map(agentIcon);
    expect(new Set(icons).size).toBe(4);
    expect(icons.every(icon => icon.startsWith("fluent-color:"))).toBe(true);
  });

  test("keeps the kind glyph once a worker finishes", () => {
    const finished = worker({ name: "token_count", task: "统计数据", status: "completed" });
    expect(agentIcon(finished)).toBe(agentIcon({ ...finished, status: "running" }));
    // A worker whose task says nothing about the work still gets a status glyph.
    expect(agentIcon(worker({ status: "completed" }))).toBe("fluent-color:checkmark-circle-24");
    expect(agentIcon(worker({ status: "failed" }))).toBe("fluent-color:error-circle-24");
  });
});

describe("agent kind edge cases", () => {
  test("protocol names do not read as design work", () => {
    expect(agentKind(worker({ name: "openui_a2ui", task: "整理 A2UI 生态里的客户端矩阵" }))).toBe("web");
    expect(agentKind(worker({ name: "agui_protocol", task: "核对 AG-UI 协议版本" }))).toBe("test");
    expect(agentKind(worker({ name: "worker", task: "调整 UI 布局与配色" }))).toBe("design");
  });

  test("count only matches whole words", () => {
    expect(agentKind(worker({ name: "token_count", task: "统计 token" }))).toBe("data");
    expect(agentKind(worker({ name: "account_setup", task: "配置账号环境" }))).toBe("setup");
  });
});
