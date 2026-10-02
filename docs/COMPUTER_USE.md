# Computer Use

Orbit has one production Computer Use path and one tool: `gui_task`.
The V2, V3, and V4 documents in `docs/archive/computer-use/` record earlier
design iterations; they are historical references, not alternate runtimes.

## Flow

```text
Pi -> gui_task -> Spotlight app resolver -> Rust ax_control worker
                                  -> AX observation -> bounded Jev choice
                                  -> one verified AX action -> successor observation
```

The worker is the only desktop driver. It owns application launch and
activation, snapshot-scoped refs, live target re-identification, action
delivery, event-driven settling, post-state reads, and retry disposition.
The TypeScript engine owns budgets, candidate compilation, text-slot privacy,
risk checks, verification, affordance memory, and the observe/decide/act loop.

## Tool Contract

`gui_task` accepts one complete goal, a natural-language target app, optional
local `textSlots`, an optional read-only flag, and explicit action/decision/time
budgets. Exact text stays in the local slot; Jev receives only its ID and
purpose. The tool exposes no selectors, coordinates, precomputed steps, or
application-specific label maps.

The worker is currently supported on macOS. Computer Use is disabled by
default and is enabled through the existing `gui-computer-use-mode` command.
Normal code, API, and CLI tools remain the path for non-GUI work.

## Observation and Actions

Observation starts with a bounded accessibility skeleton and drills into a
qualified subtree only when needed. Candidate operations come from the live
AX capabilities. This includes semantic `RIGHT_CLICK` through `AXShowMenu`
and `CLEAR` through `AXValue = ""`; both require the observed capability.
Pointer and keyboard operations activate the target app immediately before
delivery. Mutations settle through the worker's AX notifications, then the
engine compares the successor tree and verifies text values where applicable.

The engine never replays an action after uncertain or already-delivered
delivery. A retry is allowed only for an explicitly safe stale reference.
Read-only tasks reject mutation, contextual-menu, and submit operations even
if a stale candidate survives into the current turn.

## Decision Backend

`gui_task` speaks the Jev/SystemOne protocol and ships two interchangeable
backends, selected in Settings → 操作电脑 (stored in
`~/.pi/agent/computer-use.json`):

- **Jev (TypeSafe)** — the default; key at `~/.pi/agent/typesafe-api-key`.
- **Clef-flash (Cloudflare)** — Cloudflare's open 9B decision model on
  Workers AI; Account ID in the config, API Token at
  `~/.pi/agent/cloudflare-api-token`.

Clef is hosted behind Workers AI rather than a SystemOne root, so
`decision-provider.ts` gives the TypeSafe SDK a custom `fetch` that rewrites
`POST /v1/systemone` to the Workers AI run endpoint and lifts `result` back to
the top level. The engine, prompts, budgets, verification and text-slot
privacy are identical for both backends; only transport and credentials
differ. The selection is read by the Pi process at spawn time, so change it and
reconnect the project. The same page has a connection test that performs one
real SystemOne round trip and reports latency, model, answer and token usage.

## Jev and Memory

Jev chooses one operation and target from the current bounded candidate set.
It may choose `DRILL`, `WIDEN`, `WAIT`, `DONE`, or `BLOCKED`. The removed
lookahead multi-click predictor is not part of the contract: measurements did
not show a benefit and it was never safe to treat predicted steps as facts.

Successful trajectories may be stored locally as affordance memory without
text values. A replay is used only when the current observation matches; any
mismatch abandons the replay and returns to a fresh Jev decision. Set
`ORBIT_CU_MEMORY=0` to disable this optimization.

## Packaging and Verification

`scripts/sync-worker.mjs` builds `ax_control` with the `ax-control` Cargo
feature and copies it to `resources/computer-use/`. `scripts/sync-computer-use.mjs`
copies the TypeSafe SDK and clipboard runtime only; no `agent-desktop` package
or binary is shipped.

The focused Computer Use tests cover candidate capabilities, right-click and
clear compilation, target identity, delivery/retry rules, verification,
memory replay, and read-only restrictions. Run them with:

```sh
bun test tests/computer-use.test.ts tests/computer-use-engine.test.ts tests/tree-diff.test.ts
bun run check
```
