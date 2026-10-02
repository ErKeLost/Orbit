# Multi-agent architecture

Orbit adds a collaboration control plane on top of Pi 1.0.0. Pi remains the execution engine for every agent; Orbit owns parent/child lifecycle, transport projection, and UI.

## Runtime model

The parent Pi session receives a supervisor-oriented collaboration surface:

- `spawn_agent`
- `spawn_agents`
- `send_message`
- `followup_task`
- `wait_agent`
- `interrupt_agent`
- `list_agents`

These names and semantics follow Codex's collaboration surface. There is no artificial concurrency or tree-depth limit in Orbit. The parent model chooses whether to delegate, how many children to create, and whether children should delegate further.

Each child is an isolated Pi RPC process using the exact Pi runtime bundled with Orbit. Children inherit the parent model and thinking level unless the spawn request overrides them. A child receives a persistent session directory and a minimal explicit extension; ordinary user/project extensions are disabled for that process to prevent accidental duplicate registration. The minimal child extension still exposes the collaboration tools, so nested delegation remains possible.

## Event flow

```text
parent model
  -> collaboration tool
  -> SubagentRuntime
  -> child Pi RPC process
  -> Pi message/tool/lifecycle events
  -> versioned AgentSnapshot
  -> extension setStatus("gui-agents")
  -> Tauri JSONL bridge
  -> Zustand projection
  -> inline AgentActivityFeed inside the turn timeline
```

`AgentSnapshot` is the sole wire contract between the runtime and React. The UI parses it strictly instead of guessing aliases. Nested snapshots are attached to their spawning parent, producing a real agent tree.

Pi's delta-only `message_update`, `tool_execution_*`, `message_end`, `agent_end`, and `agent_settled` events drive live summaries and terminal state. Snapshot publication is trailing-throttled to 64 ms so token streaming does not trigger a webview IPC/render for every delta.

## Lifecycle and communication

`spawn_agent` is the normal supervisor delegation primitive: it starts one isolated child Pi process, waits for `agent_settled`, and returns the child's completed result as the tool result for the parent's next model iteration. `spawn_agents` is the explicit parallel primitive for independent work; it starts all requested children, waits for all of them, and returns one result per task for synthesis. This matches the agents-as-tools pattern used by current supervisor frameworks: process state is internal, while the parent model receives a bounded result contract.

The parent still has a barrier at `agent_end` for legacy/background control calls, so a parent cannot race ahead with ordinary repository tools while an explicitly controlled child remains active. `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, and `list_agents` are lifecycle controls for an already-running delegation, not substitutes for the completed result returned by `spawn_agent` or `spawn_agents`. Completed children keep their RPC context for follow-up work; all child processes are reclaimed when the next top-level run begins or the parent session shuts down.

`spawn_agents` accepts at most eight tasks per delegation and the runtime enforces the same active-child limit across nested calls. This bounds process, provider, and UI pressure without imposing an arbitrary tree-depth limit.

Cancellation sends Pi's `clear_queue` and `abort` commands before terminating the process. Child sessions are persisted and become openable from the activity panel after settlement.

## Bundled Pi

`scripts/bundle-pi.mjs` builds the locked `@earendil-works/pi-coding-agent` dependency into a self-contained Node bundle and stages required themes, HTML-export assets, and Photon resources. Tauri resolves this application resource first, then supports project/global Pi only as compatibility fallbacks. Parent and child processes receive the same resolved CLI and Node paths through `ORBIT_PI_*` environment variables.

Users therefore do not need a separate Pi installation. A compatible Node runtime is still required by the desktop application.

## Pi API coverage

The primary Orbit integration retains its typed coverage of all 33 Pi RPC commands. The multi-agent runtime uses the subset appropriate to child control: prompt/steer/follow-up behavior, state, streaming messages, tool execution, queue clearing, abort, and session persistence. It does not proxy unrelated commands merely to duplicate the parent API surface.

The composer's **Pi / Multi Agent** segmented control enables or disables all collaboration tools as one capability set. New installations default to Pi mode; the user's choice is persisted. Tool membership is derived from one exported protocol list so the extension command and registered tool surface cannot drift.
