import { describe, expect, test } from "bun:test"
import { buildSessionContext, parseSessionEntries, type SessionEntry } from "@earendil-works/pi-coding-agent"
import { filterForkSession } from "../src-tauri/resources/subagents/fork.ts"

const encoder = new TextEncoder()

const HEADER = {
  type: "session",
  version: 3,
  id: "session-1",
  timestamp: "2024-01-01T00:00:00.000Z",
  cwd: "/repo",
  parentSession: "/parent.jsonl",
}

function user(id: string, parentId: string | null, text: string) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2024-01-01T00:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
  }
}

function assistant(id: string, parentId: string | null, content: unknown[]) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2024-01-01T00:00:02.000Z",
    message: {
      role: "assistant",
      provider: "anthropic",
      api: "anthropic-messages",
      model: "claude",
      stopReason: "toolUse",
      content,
      timestamp: 2,
    },
  }
}

function toolResult(id: string, parentId: string | null, toolCallId: string, toolName: string, text: string) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2024-01-01T00:00:03.000Z",
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      isError: false,
      content: [{ type: "text", text }],
      timestamp: 3,
    },
  }
}

const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args })
const text = (value: string) => ({ type: "text", text: value })
const thinking = (value: string) => ({ type: "thinking", thinking: value, signature: "sig" })

function session(entries: unknown[]): string {
  return `${[HEADER, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`
}

function outputLines(content: string): unknown[] {
  return content
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function outputEntries(content: string): Record<string, unknown>[] {
  return outputLines(content).slice(1)
}

function messagesOf(content: string) {
  const entries = parseSessionEntries(content).filter(
    (entry): entry is SessionEntry => entry.type !== "session",
  )
  return buildSessionContext(entries).messages
}

describe("filterForkSession", () => {
  test("1. keeps the header as the first line", () => {
    const raw = session([user("u1", null, "hello")])
    const { content, stats } = filterForkSession(raw)

    const lines = content.split("\n").filter((line) => line.trim() !== "")
    expect(JSON.parse(lines[0]!)).toEqual(HEADER)
    // Header is not counted as a kept entry.
    expect(stats.kept).toBe(1)
  })

  test("2. drops every toolResult entry", () => {
    const raw = session([
      user("u1", null, "look at this"),
      assistant("a1", "u1", [text("checking"), call("tc-1", "read", { path: "a.ts" })]),
      toolResult("t1", "a1", "tc-1", "read", "FILE BODY"),
      assistant("a2", "t1", [text("done")]),
    ])
    const { content, stats } = filterForkSession(raw)

    const ids = outputEntries(content).map((entry) => entry.id)
    expect(ids).not.toContain("t1")
    expect(content).not.toContain("FILE BODY")
    expect(stats.droppedToolResults).toBe(1)
  })

  test("3. removes toolCall blocks but keeps assistant text", () => {
    const raw = session([
      user("u1", null, "go"),
      assistant("a1", "u1", [text("I will inspect the file."), call("tc-1", "read", { path: "a.ts" }), thinking("internal reasoning")]),
    ])
    const { content, stats } = filterForkSession(raw)

    const a1 = outputEntries(content).find((entry) => entry.id === "a1") as { message: { content: unknown[] } }
    expect(a1).toBeDefined()
    expect(a1.message.content).toEqual([text("I will inspect the file.")])
    // Codex drops Reasoning as well; thinking blocks must not survive the fork.
    expect(a1.message.content.some((block) => (block as { type: string }).type !== "text")).toBe(false)
    expect(stats.droppedToolCalls).toBe(1)
  })

  test("4. drops an assistant entry that is only a toolCall", () => {
    const raw = session([
      user("u1", null, "go"),
      assistant("a1", "u1", [call("tc-1", "read", { path: "a.ts" })]),
    ])
    const { content, stats } = filterForkSession(raw)

    expect(outputEntries(content).map((entry) => entry.id)).toEqual(["u1"])
    expect(stats.dropped).toBe(1)
    expect(stats.droppedToolCalls).toBe(1)
  })

  test("5. rewrites parentId into a linear chain rooted at null", () => {
    const raw = session([
      user("u1", null, "go"),
      assistant("a1", "u1", [text("step 1"), call("tc-1", "read", { path: "a.ts" })]),
      toolResult("t1", "a1", "tc-1", "read", "body"),
      assistant("a2", "t1", [text("step 2"), call("tc-2", "edit", { path: "a.ts" })]),
      toolResult("t2", "a2", "tc-2", "edit", "ok"),
      assistant("a3", "t2", [call("tc-3", "bash", { command: "ls" }), text("step 3")]),
    ])
    const { content } = filterForkSession(raw)
    const entries = outputEntries(content)

    expect(entries.map((entry) => entry.id)).toEqual(["u1", "a1", "a2", "a3"])
    expect(entries.map((entry) => entry.parentId)).toEqual([null, "u1", "a1", "a2"])

    // The chain must survive Pi's own traversal: every kept message stays reachable.
    const messages = messagesOf(content)
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant", "assistant"])
    const assistantTexts = messages
      .filter((message) => message.role === "assistant")
      .map((message) => (message.content as Array<{ type: string; text?: string }>).filter((block) => block.type === "text").map((block) => block.text).join(""))
    expect(assistantTexts).toEqual(["step 1", "step 2", "step 3"])
  })

  test("6. reports accurate kept/dropped/byte statistics", () => {
    const raw = session([
      user("u1", null, "go"),
      assistant("a1", "u1", [text("working"), call("tc-1", "read", { path: "a.ts" })]),
      toolResult("t1", "a1", "tc-1", "read", "body"),
      assistant("a2", "t1", [call("tc-2", "edit", { path: "a.ts" })]),
      { type: "compaction", id: "c1", parentId: "a2", timestamp: "2024-01-01T00:00:04.000Z", summary: "s", firstKeptEntryId: "u1", tokensBefore: 1 },
      { type: "usage", id: "us1", parentId: "c1", timestamp: "2024-01-01T00:00:05.000Z", kind: "turn", provider: "p", model: "m", usage: {} },
      assistant("a3", "us1", [text("final")]),
    ])
    const { content, stats } = filterForkSession(raw)

    expect(stats.kept).toBe(3) // u1, a1, a3
    expect(stats.dropped).toBe(4) // t1, a2 (toolCall-only), compaction, usage
    expect(stats.droppedToolResults).toBe(1)
    expect(stats.droppedToolCalls).toBe(2) // a1 + a2
    expect(stats.bytesBefore).toBe(encoder.encode(raw).length)
    expect(stats.bytesAfter).toBe(encoder.encode(content).length)
    expect(stats.bytesAfter).toBeGreaterThan(0)
    expect(stats.bytesAfter).toBeLessThan(stats.bytesBefore)
  })

  test("7. survives empty input, header-only input and corrupt lines", () => {
    const empty = filterForkSession("")
    expect(empty.content).toBe("")
    expect(empty.stats).toEqual({
      kept: 0,
      dropped: 0,
      droppedToolResults: 0,
      droppedToolCalls: 0,
      bytesBefore: 0,
      bytesAfter: 0,
    })

    const headerOnly = filterForkSession(`${JSON.stringify(HEADER)}\n`)
    expect(headerOnly.content).toBe(`${JSON.stringify(HEADER)}\n`)
    expect(headerOnly.stats.kept).toBe(0)
    expect(headerOnly.stats.dropped).toBe(0)

    const corrupt = filterForkSession(`${JSON.stringify(HEADER)}\n{ not json\n${JSON.stringify(user("u1", null, "still here"))}\n\n`)
    expect(corrupt.content.split("\n")[0]).toBe(JSON.stringify(HEADER))
    expect(outputEntries(corrupt.content).map((entry) => entry.id)).toEqual(["u1"])
    expect(corrupt.stats.dropped).toBe(1)

    // No header at all is also safe.
    const noHeader = filterForkSession(`${JSON.stringify(user("u1", null, "hi"))}\n`)
    expect(outputLines(noHeader.content).map((entry) => (entry as { id: string }).id)).toEqual(["u1"])
    expect(noHeader.stats.kept).toBe(1)
  })

  test("8. a session dominated by tool results shrinks dramatically", () => {
    const bigBody = "x".repeat(200_000)
    const bigDiff = "y".repeat(150_000)
    const raw = session([
      user("u1", null, "refactor the file"),
      assistant("a1", "u1", [text("Reading the current file."), call("tc-1", "read", { path: "big.ts" })]),
      toolResult("t1", "a1", "tc-1", "read", bigBody),
      assistant("a2", "t1", [text("Applying the change."), call("tc-2", "edit", { path: "big.ts" })]),
      toolResult("t2", "a2", "tc-2", "edit", bigDiff),
      assistant("a3", "t2", [text("Edit applied.")]),
    ])
    const { content, stats } = filterForkSession(raw)

    expect(stats.bytesBefore).toBeGreaterThan(350_000)
    // Only the narrative survives, so the fork should be a small fraction of the parent.
    expect(stats.bytesAfter).toBeLessThan(stats.bytesBefore * 0.05)
    expect(stats.droppedToolResults).toBe(2)
    expect(stats.droppedToolCalls).toBe(2)
    expect(stats.kept).toBe(4) // u1, a1, a2, a3
    expect(content).not.toContain(bigBody)
    expect(content).not.toContain(bigDiff)
    expect(messagesOf(content).map((message) => message.role)).toEqual(["user", "assistant", "assistant", "assistant"])
  })
})
