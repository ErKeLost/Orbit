# Multi-agent architecture

Orbit adds a collaboration control plane on top of Pi 1.0.0. Pi remains the execution engine for every agent; Orbit owns parent/child lifecycle, transport projection, and UI.

The interaction model follows Codex's V2 multi-agent surface: **delegation is asynchronous**. `spawn_agent` returns as soon as a worker has started, and the worker's answer arrives later as a message injected into the supervisor's own conversation. The supervisor is never blocked while workers run.

## Runtime model

The parent Pi session receives exactly the Codex V2 collaboration surface:

- `spawn_agent`
- `send_message`
- `followup_task`
- `wait_agent`
- `interrupt_agent`
- `list_agents`

There is deliberately **no batch spawner**. Because spawning does not block, independent work is requested by emitting several `spawn_agent` calls in one turn; they start concurrently. Adding a batch primitive on top of a non-blocking spawn would be redundant.

There is no artificial concurrency or tree-depth limit. The parent model chooses whether to delegate, how many children to create, and whether children should delegate further. The runtime bounds process pressure instead: at most 8 active workers, and settled workers are evicted oldest-first once 12 are alive.

### Agent paths

Every agent has a canonical path, borrowed from Codex's `AgentPath`: the supervisor is `/root`, and a worker spawned with `task_name` takes `<spawner path>/<task_name>`. A worker is told its own path, receives it in the environment as `PI_GUI_AGENT_PATH`, and passes it on to its own children, so a nested tree branches correctly.

A path segment must be lowercase letters, digits and underscores; `root`, `.` and `..` are reserved and a `/` is rejected. An unusable `task_name` fails the spawn with a clear message rather than being silently rewritten, so the name a model asks for is the name it gets.

Targets resolve by agent id, by absolute path (`/root/a/b`), or by a reference relative to the caller (`b`), matching Codex's `AgentPath::resolve`. `list_agents` filters on real path prefixes.

Each child is an isolated Pi RPC process using the exact Pi runtime bundled with Orbit. Children inherit the parent model and thinking level unless the spawn request overrides them. A child receives a persistent session directory and a minimal explicit extension; ordinary user/project extensions are disabled for that process to prevent accidental duplicate registration. The minimal child extension still exposes the collaboration tools, so nested delegation remains possible.

Workers also keep the capability-bearing built-in extensions. `--no-extensions` turns off extension *discovery* and built-in extensions in one switch, which is what keeps Orbit's own GUI extension from registering itself inside a worker — but it also strips MCP, codemode, tool search, and the local model provider. Those four are therefore re-added explicitly (`--extension builtin:mcp`, `builtin:codemode`, `builtin:tool-search`, `builtin:llama.cpp`). A worker reaches MCP servers from `mcp.json` through codemode, exactly as the supervisor does by default. Discovery stays off, so no GUI command ever exists in a worker.

## Delivering results

`spawn_agent` returns an acknowledgement — the worker's canonical path and id — never its answer. When a worker's turn reaches a terminal state, `SubagentRuntime` hands the result to the host, which injects it with `pi.sendMessage(..., { triggerTurn: true })`:

```text
Message Type: FINAL_ANSWER
Task name: <recipient path>
Sender: <worker path>
Status: <completed | failed | aborted>
Payload:
<the worker's final assistant text, truncated at 50 KB>
```

The initial task uses the same envelope in the other direction, so one format covers both ways a message crosses the tree:

```text
Message Type: NEW_TASK
Task name: <worker path>
Sender: <spawner path>
Payload:
<the task>
```

`triggerTurn: true` covers both cases correctly. While the supervisor is running, Pi steers the message into its next request, so a `wait_agent` call returns and the model immediately sees the result. When the supervisor is idle, Pi starts a turn instead, so a result is never stranded.

`wait_agent` therefore only waits for a **signal** and returns a summary of which workers have updates — never their content. This is the Codex contract, and it is why worker output does not appear inside a tool result.

## Worker context

`spawn_agent` accepts `context: "inherit" | "isolated"`, defaulting to `inherit`. An inherited worker starts with Pi's `--fork <source>` flag, so Pi copies entries into a fresh session inside the worker's own session directory and keeps the `parentSession` link in the header. Orbit never re-serializes the conversation into the prompt.

The fork source is **filtered**, mirroring Codex's `keep_forked_rollout_item`: the supervisor's entries are rewritten into a tool-free transcript first. Kept are the user turns and the assistant's prose; dropped are tool results, tool calls inside assistant content, thinking blocks, compactions, and inter-agent messages. Retained entries get a linear `parentId` chain so Pi can still walk the history.

This is where most of the saving comes from. Tool results — file contents, diffs, command output — dominate a coding session's bytes, and a worker can read any of it again for itself. Measured on real sessions, pure-code sessions shrink by 93–97%; sessions dominated by base64 images shrink much less, because the images live in user turns, which are kept.

`context: "isolated"` starts an empty session instead, for self-contained work where the shared history would only add cost and noise. Pi persists a session lazily (on the first conversation entry), so if the supervisor's session file does not exist yet, an inheritance request degrades to an isolated worker rather than failing the delegation. The same fallback applies if filtering throws: the raw session file is used rather than failing the spawn.

Because the supervisor's own delegation call is stripped along with the other tool calls, a forked worker never sees a dangling tool call, so no synthetic tool result is needed.

## Lifecycle and communication

`send_message` and `followup_task` match Codex's two delivery modes. `send_message` queues onto a running worker without starting a turn; `followup_task` also starts a turn when the worker is idle. Pi has no "queue without starting" for an idle RPC agent, so a `send_message` to an idle worker is buffered in Orbit and prepended to that worker's next task instead of being lost.

Targets resolve by agent id or by task name. An ambiguous name is rejected rather than guessed.

All worker processes are reclaimed when the supervisor session shuts down, and settled workers are evicted oldest-first once 12 are alive. A new top-level user turn does **not** reclaim anything: the GUI sends its mode-sync prompts concurrently with the user's own message, so reclaiming on input can race a spawn and kill live work. Process pressure is bounded by eviction, which only ever touches workers that have already finished. Cancellation sends Pi's `clear_queue` and `abort` commands before terminating the process. Child sessions are persisted and become openable from the activity panel after settlement.

## Shared working directory

Every agent in the tree runs in the same working directory and sees the same filesystem, so a worker's edit is immediately visible to its supervisor and to its siblings. The orchestration instructions say so explicitly, together with the concurrency budget and the advice to prefer long waits over polling. Codex states the same constraint the same way: as a warning to the model, not as a runtime lock. Orbit adds one line Codex does not have — do not silently revert another agent's changes — because that is the failure mode a shared directory actually produces.

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

## Bundled Pi

`scripts/bundle-pi.mjs` builds the locked `@earendil-works/pi-coding-agent` dependency into a self-contained Node bundle and stages required themes, HTML-export assets, and Photon resources. Tauri resolves this application resource first, then supports project/global Pi only as compatibility fallbacks. Parent and child processes receive the same resolved CLI and Node paths through `ORBIT_PI_*` environment variables.

Users therefore do not need a separate Pi installation. A compatible Node runtime is still required by the desktop application.

## Pi API coverage

The primary Orbit integration retains its typed coverage of all 33 Pi RPC commands. The multi-agent runtime uses the subset appropriate to child control: prompt/steer/follow-up behavior, state, streaming messages, tool execution, queue clearing, abort, and session persistence. It does not proxy unrelated commands merely to duplicate the parent API surface.

The composer's **Pi / Multi Agent** segmented control enables or disables all collaboration tools as one capability set. New installations default to Pi mode; the user's choice is persisted. Tool membership is derived from one exported protocol list so the extension command and registered tool surface cannot drift.

## Not carried over from Codex

Codex has two collaboration features Orbit does not implement, and two remaining differences:

- **Message board** — Codex ships channels, posts, subscriptions and search (`create_channel`, `post`, `subscribe`, …) with optional SQLite persistence. Pi has no equivalent channel model; building one is a separate project.
- **Named agent roles** — Codex loads `agent_type` definitions from TOML that can change a child's model, instructions and features. Orbit only supports the model/thinking overrides on the spawn call.
- **Session-temporary MCP servers.** Servers persisted to `~/.pi/agent/mcp.json` (or a trusted project's `.pi/mcp.json`) reach workers, because the built-in MCP extension reads the same files. Servers registered for one session through `/gui-mcp add` live only in the supervisor's process memory, so a worker does not see them.
- **Concurrent edits.** Codex's supervisor and workers share one working directory and may edit it concurrently. Orbit no longer blocks the supervisor either, so the same hazard applies: nothing in the runtime serializes repository writes between agents. Both the supervisor and every worker are told this explicitly — the same note Codex injects — including that another agent's edits are immediately visible, that another agent's changes must not be silently reverted, and how many workers may run at once. The constraint is advisory in both systems.

`tsconfig.subagents.json` type-checks this directory; it is separate from the app configs and runs as `check:subagents`.
