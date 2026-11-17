import { describe, expect, test } from "bun:test";
import type { Part, Tool } from "../src/lib/protocol";
import type { TurnStep } from "../src/features/chat/turnModel";
import { latestPlan, latestTodos, parsePlanKey, planFromSteps, sessionPlanKey, todosFromValue } from "../src/features/chat/todos";

const tool = (id: string, name: string, extra: Partial<Tool> = {}): Tool => ({ name, running: false, ...extra, args: extra.args });

function step(key: string, part: Part): TurnStep {
  return { key, kind: "tool", part, messageIndex: 0, live: false };
}

describe("todowrite", () => {
  test("keeps a well-formed list and drops blank rows", () => {
    expect(todosFromValue([
      { content: "Find the fetch", status: "in_progress" },
      { content: "  ", status: "pending" },
      { content: "Add a test", status: "nope" },
    ])).toEqual([
      { content: "Find the fetch", status: "in_progress" },
      { content: "Add a test", status: "pending" },
    ]);
    expect(todosFromValue({ todos: [] })).toBeNull();
  });

  test("the latest write is the plan, and later tool calls hang off the item in progress", () => {
    const write: Part = { type: "toolCall", id: "todo-1", name: "todowrite", arguments: { todos: [
      { content: "Finding where search fetches results", status: "in_progress" },
      { content: "Add a test", status: "pending" },
    ] } };
    const search: Part = { type: "toolCall", id: "grep-1", name: "grep", arguments: { pattern: "setQuery" } };
    const tools = {
      "todo-1": tool("todo-1", "todowrite", { durationMs: 8000 }),
      "grep-1": tool("grep-1", "grep", { durationMs: 7000 }),
    };
    const plan = planFromSteps([
      { key: "note", kind: "note", text: "Debounce the search value, wire it in, then prove it with a test.", messageIndex: 0, live: false },
      step("write", write),
      step("search", search),
    ], tools);
    expect(plan?.note).toBe("Debounce the search value, wire it in, then prove it with a test.");
    expect(plan?.todos).toHaveLength(2);
    expect(plan?.children).toEqual([{ key: "search", label: "Searching for “setQuery”", durationMs: 7000, running: false }]);
    expect(plan?.durationMs).toBe(8000);
  });

  test("a failed write does not replace the plan already on screen", () => {
    const first: Part = { type: "toolCall", id: "ok", name: "todowrite", arguments: { todos: [{ content: "Ship it", status: "pending" }] } };
    const failed: Part = { type: "toolCall", id: "bad", name: "todowrite", arguments: { todos: [{ content: "Ignore me", status: "completed" }] } };
    const messages = [
      { id: "a", message: { role: "assistant", content: [first] } },
      { id: "b", message: { role: "assistant", content: [failed] } },
    ];
    expect(latestTodos(messages, { bad: tool("bad", "todowrite", { isError: true }) })).toEqual([{ content: "Ship it", status: "pending" }]);
  });

  test("the composer plan keeps calls after the latest write, and stops at the next user turn", () => {
    const write: Part = { type: "toolCall", id: "todo-1", name: "todowrite", arguments: { todos: [
      { content: "Wire the room", status: "in_progress" },
      { content: "Draw the match", status: "pending" },
    ] } };
    const read: Part = { type: "toolCall", id: "read-1", name: "read", arguments: { path: "vite.config.ts" } };
    const later: Part = { type: "toolCall", id: "read-2", name: "read", arguments: { path: "package.json" } };
    const messages = [
      { id: "u1", message: { role: "user", content: "build it" } },
      { id: "a1", message: { role: "assistant", content: [write, read] } },
      { id: "u2", message: { role: "user", content: "continue" } },
      { id: "a2", message: { role: "assistant", content: [later] } },
    ];
    const tools = {
      "todo-1": tool("todo-1", "todowrite"),
      "read-1": tool("read-1", "read", { running: true }),
      "read-2": tool("read-2", "read"),
    };
    const plan = latestPlan(messages, tools);
    expect(plan?.todos.map((todo) => todo.content)).toEqual(["Wire the room", "Draw the match"]);
    expect(plan?.children.map((child) => child.label)).toEqual(["Reading vite.config.ts"]);
    expect(plan?.children[0]?.running).toBe(true);
    const key = sessionPlanKey(messages, tools);
    expect(parsePlanKey(key)?.children.map((child) => child.label)).toEqual(["Reading vite.config.ts"]);
    expect(sessionPlanKey(messages, tools)).toBe(key);
  });
});
