/**
 * Codex-style filtered fork.
 *
 * `pi --fork <session>` copies the parent's transcript verbatim, including every
 * `toolResult` entry (full file bodies, diffs, command output) and every
 * `toolCall` block. That is the bulk of the inherited context and almost none of
 * it is useful to a freshly spawned worker.
 *
 * This module mirrors Codex's `keep_forked_rollout_item`
 * (`codex-rs/core/src/agent/control/spawn.rs`): keep the conversation narrative
 * (system/user messages and assistant text), drop the tool plumbing
 * (`toolResult` messages, `toolCall` blocks, reasoning blocks) and all
 * bookkeeping entries (compaction, usage, labels, model/thinking changes, ...).
 *
 * ## parentId linearization
 *
 * Pi resolves the active transcript by walking the `parentId` chain from the
 * leaf (`buildContextEntries` / `buildSessionPath`). Dropping entries without
 * reparenting leaves orphans, so anything after the first dropped entry becomes
 * unreachable and silently disappears from the worker's context.
 *
 * We therefore rewrite the kept entries into a single linear chain: the first
 * kept entry gets `parentId: null` and every later entry points at the
 * previously kept entry's id. Entry ids and the header are never rewritten.
 */

export interface ForkFilterStats {
  /** Entries kept, excluding the header. */
  kept: number
  /** Entries (and unparseable lines) dropped, excluding the header. */
  dropped: number
  /** `toolResult` messages dropped. */
  droppedToolResults: number
  /** Individual `toolCall` blocks removed from assistant messages. */
  droppedToolCalls: number
  /** UTF-8 byte length of the raw input. */
  bytesBefore: number
  /** UTF-8 byte length of the filtered output. */
  bytesAfter: number
}

type JsonRecord = Record<string, unknown>

/** UTF-8 byte length without depending on Node's `Buffer` typing. */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseLine(line: string): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(line)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Strip an assistant message's `content` down to its textual answer.
 *
 * - `toolCall` blocks are removed and counted.
 * - `thinking`/reasoning blocks are removed (Codex drops `Reasoning`; they are
 *   also provider-scoped and invalid once the tool-call chain is gone).
 * - The entry is discarded when no non-empty `text` block survives, which is
 *   exactly the "assistant only called a tool" case.
 */
function filterAssistantContent(content: unknown): { content: unknown; droppedToolCalls: number } {
  // Defensive: legacy/opaque entries may store a bare string.
  if (typeof content === "string") {
    return { content: content.trim() === "" ? null : content, droppedToolCalls: 0 }
  }
  if (!Array.isArray(content)) {
    return { content: null, droppedToolCalls: 0 }
  }

  const kept: unknown[] = []
  let droppedToolCalls = 0
  let hasText = false

  for (const block of content) {
    if (isRecord(block)) {
      if (block.type === "toolCall") {
        droppedToolCalls += 1
        continue
      }
      if (block.type === "thinking") {
        continue
      }
      if (block.type === "text") {
        const text = typeof block.text === "string" ? block.text : ""
        if (text.trim() === "") continue
        kept.push(block)
        hasText = true
        continue
      }
    }
    // Unknown non-text block: keep it, but it cannot satisfy the "has text" bar.
    kept.push(block)
  }

  return { content: hasText ? kept : null, droppedToolCalls }
}

/**
 * Filter a raw parent session file (JSONL) into a worker-safe transcript.
 *
 * Never throws: unparseable lines are dropped, an empty input yields an empty
 * output, and a header-only input round-trips the header.
 */
export function filterForkSession(raw: string): { content: string; stats: ForkFilterStats } {
  const stats: ForkFilterStats = {
    kept: 0,
    dropped: 0,
    droppedToolResults: 0,
    droppedToolCalls: 0,
    bytesBefore: byteLength(raw),
    bytesAfter: 0,
  }

  // Blank lines are not entries; ignore them entirely (but a final newline is normal).
  const lines = raw.split("\n").filter((line) => line.trim() !== "")
  if (lines.length === 0) {
    return { content: "", stats }
  }

  let headerLine: string | null = null
  let index = 0
  const first = parseLine(lines[0])
  if (first && first.type === "session") {
    headerLine = lines[0]
    index = 1
  }

  const keptEntries: JsonRecord[] = []

  for (; index < lines.length; index += 1) {
    const entry = parseLine(lines[index])
    if (!entry) {
      stats.dropped += 1
      continue
    }
    if (entry.type !== "message" || !isRecord(entry.message)) {
      // Drops compaction, branch_summary, usage, label, session_info,
      // thinking_level_change, model_change, custom, context_edit, custom_message.
      stats.dropped += 1
      continue
    }

    const message = entry.message
    const role = message.role

    if (role === "toolResult") {
      stats.droppedToolResults += 1
      stats.dropped += 1
      continue
    }

    if (role === "user" || role === "system") {
      keptEntries.push(entry)
      continue
    }

    if (role === "assistant") {
      const { content, droppedToolCalls } = filterAssistantContent(message.content)
      stats.droppedToolCalls += droppedToolCalls
      if (content === null) {
        stats.dropped += 1
        continue
      }
      keptEntries.push({ ...entry, message: { ...message, content } })
      continue
    }

    // Unknown role: keep nothing we do not understand.
    stats.dropped += 1
  }

  // Reparent survivors into one linear chain so Pi's parentId walk cannot break.
  const outputEntries: JsonRecord[] = []
  for (const entry of keptEntries) {
    const previous = outputEntries[outputEntries.length - 1]
    const id = typeof entry.id === "string" ? entry.id : `fork-${outputEntries.length}`
    outputEntries.push({ ...entry, id, parentId: previous ? previous.id : null })
  }

  const outputLines: string[] = []
  if (headerLine !== null) outputLines.push(headerLine)
  for (const entry of outputEntries) outputLines.push(JSON.stringify(entry))

  const content = outputLines.length > 0 ? `${outputLines.join("\n")}\n` : ""
  stats.kept = outputEntries.length
  stats.bytesAfter = byteLength(content)
  return { content, stats }
}
