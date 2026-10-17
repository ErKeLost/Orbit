# Computer Use — Cua Driver + Jev architecture

This document is the target architecture for the Computer Use rewrite. It
replaces the self-built `ax_control` driver path described in
[COMPUTER_USE.md](COMPUTER_USE.md). The old document stays until the cutover is
verified; both paths ship behind a switch during the migration.

## Why the rewrite

A recorded run (`汽水音乐播放测试`) showed the old loop failing for two reasons
that a newer decision model cannot fix:

1. **Anonymous controls.** The search box reached Jev as
   `text_field embedded control; … trailing embedded control at 87%` — no
   label, no value. Jev guessed among icon buttons and typed into the wrong one.
   Cua Driver reports the same element as
   `AXTextField label="歌手、歌曲或专辑名" value="歌手、歌曲或专辑名"` with an
   `element_token`, so the target is identifiable.
2. **Unbounded repeats.** The engine double-clicked the same row 8 times and
   clicked `link "风清扬"` 14 times. `repeatedCycle()` ignores single-target
   repeats by design, and `unchangedMutations` never accumulated because the
   accessibility tree oscillated between two fingerprints, so `changed=true`
   every turn.

Neither is a model-quality problem. The decision input was ambiguous and the
loop had no brake.

## Ownership

```text
Pi (model)
  └─ gui_task (extension, this repo)
       ├─ candidate sources + code facts + policy + stall rules   [runner]
       ├─ Jev / SystemOne choice over supplied IDs                 [chooser]
       └─ cua-driver mcp (stdio MCP child)                         [driver]
            └─ CuaDriver.app daemon (owns Accessibility + Screen Recording)
                 └─ OS accessibility + input + ScreenCaptureKit
```

The driver owns observation, element/capture binding, actions and read-back.
The runner owns candidates, the task spec, role mapping, redaction, policy and
the loop. The chooser owns exactly one decision: which supplied ID.

Model logic, credentials, prompts and task semantics never enter the driver.
Coordinates, tool names, generated text and raw refs never enter the chooser.

## Integration: our own tool calls, no MCP

The driver is used as an **executor**, never as a protocol: the runner spawns
`cua-driver call <tool> '<json>'` per action and reads JSON back — the same
shape as the previous `ax_control` worker. MCP is not used anywhere in the
runtime.

On top of that executor the runner defines **its own tool surface**:
`click`, `right_click`, `type_text`, `set_value`, `press_key`, `hotkey`,
`scroll`, `menu`, `reparse`, plus the reserved `done`, `reobserve` and
`abstain`. That vocabulary is ours; it is what the chooser sees and what the
loop executes. The driver's 60 MCP tool names never reach the model.

Two things must be true for one-process-per-call to work, both measured on
driver 0.35.4:

- `snapshot_id` and `element_token` survive across separate `call` processes;
  the daemon keys the snapshot registry by `(pid, window_id)`, and a new
  snapshot of the same window invalidates the previous tokens.
- `capture_id` survives **only** when every call repeats the same `session`
  label. Without it the call gets a disposable session and
  `parse_visual_regions` returns `capture_not_found`. The client therefore
  repeats one generated `orbit-<pid>-<time>` label for the whole run and calls
  `end_session` on dispose.

Every tool except `list_sessions` declares a `session` field; sending one
anywhere else is a 400, so the client injects it through a
`NO_SESSION_TOOLS` exclusion rather than an allow-list.

This avoids shipping the native `@trycua/cua-driver` uniffi binding inside
Orbit. The `CuaDriver.app` daemon is what holds the TCC grants; the runner
fails with a structured `DRIVER_UNAVAILABLE` / `DRIVER_NOT_GRANTED` code when
it is missing.

### Observation cost and completeness

`get_window_state` always returns both the element tree and a screenshot; the
modality is chosen at action time by how the target is addressed. `max_elements`
defaults to 250 and `timeout_ms` to 1000 ms, and the walk stops at whichever
binds first — so a healthy 608-element Chrome tree still reports
`elements_complete: false`. The loop sets both explicitly and treats
`elements_complete: false` as **partial**: a partial tree may produce candidates
but must never conclude an area is empty, and never triggers the visual
fallback on its own.

## Driver surface used

| Tool | Use |
|---|---|
| `list_apps` | Resolve the target app to a `pid`. Replaces Spotlight resolution for running apps; Spotlight stays for launch-only. |
| `list_windows` | Pick the target `window_id` (`on_screen_only`). |
| `get_window_state` | One observation: accessibility tree (`tree_format: "elements"`) + optional screenshot in the same call, sharing `snapshot_id` and `capture_id`. `since` gives a delta. |
| `parse_visual_regions` | Optional perception extension: text/icon regions from one `capture_id`. Fallback only. |
| `click` | `element_token` (semantic, background) or `x,y` + `capture_id` (capture-bound). `delivery_mode: background \| foreground`. |
| `type_text`, `set_value` | Text into a `element_token`; background first. |
| `press_key`, `hotkey` | Return, Escape, Cmd-… |
| `scroll` | Target-scoped scroll. |
| `verify_state` | Independent postcondition check by element selector. |

Key invariants copied from the driver contract:

- `element_token` is `s<snapshot8>:<index>` and is invalidated by the next
  snapshot. A stale token is `stale_element_token` → observe again, never replay.
- Every action returns `effect` (`confirmed` / `unverifiable` / `suspected_noop`
  / `partial` / `refused`), `escalation` (`px` / `page` / `foreground`) and
  `verified` (true only for accessibility read-back).
- A returned action is **not** evidence. The successor observation is.
- A background refusal (`background_*`) is never retried in the foreground
  implicitly; a distinct `*-foreground` candidate must be selected explicitly.
- `elements_complete: false` means partial. A partial tree must never conclude
  that an area has no element, and must never trigger the visual fallback alone.

## Candidate sources

All sources implement one interface and tag every candidate with a `source`.

```ts
type CandidateSourceKind = "ax" | "visual" | "page"

interface Candidate {
  id: string                  // stable, snapshot-independent, `[A-Za-z0-9][A-Za-z0-9._:-]{0,63}`
  description: string         // bounded, redacted
  source: CandidateSourceKind | null  // null only for reserved IDs
  tool: string | null         // null only for reserved IDs
  arguments: Readonly<Record<string, unknown>>  // frozen, complete
  captureId?: string          // capture-bound visual/pixel actions
}
```

- **`ax`** — from `get_window_state` elements: enabled, on-screen, labelled,
  actionable. Role is mapped to a closed role class through an explicit table;
  unknown roles are excluded, never guessed. ID is derived from role class +
  label, plus an index **only when several controls share the same role and
  label** — otherwise two rows of a list get one identity, and quarantining the
  wrong row would take the right one with it. A description of such a control
  says which of the equal-labelled ones it is, because an id the chooser cannot
  read is not a choice. The candidate list is bounded (24 executable); when the
  cap drops anything, the observation header and the history say so and scroll
  stays available, so a target at the end of the tree cannot simply vanish.
- **`visual`** — from `parse_visual_regions`. Only when the `ax` source offers
  nothing for a declared step, and never from a partial tree. A visual target
  needs an exact unique text match at OCR confidence ≥ 0.8 unless the task
  lowers it.
- **`page`** — browser tabs over the driver's browser tools. Not used by
  `gui_task` initially; present so the interface is not special-cased later.

The offer set is bounded: at most 24 executable actions, plus the reserved
`reobserve` and `abstain`. Risky labels (delete, send, purchase, close …) are
left out unless the task allows them. Typed text comes only from the task's
local `textSlots`.

## Choice contract (v2)

`cua.jev_choice_request_v2` (the version that adds `source`):

```jsonc
{
  "schema": "cua.jev_choice_request_v2",
  "goal": "…",
  "capture_id": "… | null",
  "snapshot_id": "…",
  "regions": [ /* compact visual regions, source of truth for pixels */ ],
  "history": [ /* outcome-only entries */ ],
  "progress": { "actions": 0, "decisions": 0, "performedSteps": {} },
  "candidates": [
    { "id": "…", "description": "…", "source": "ax" },
    { "id": "reobserve", "description": "…", "source": null },
    { "id": "abstain",   "description": "…", "source": null }
  ]
}
```

The chooser answers `cua.jev_choice_v1`: `{ schema, selected_id, confidence,
probabilities }`. The runner accepts exactly one known ID and dispatches the
prebuilt candidate unchanged. Unknown keys are rejected — v1 validators reject
anything they do not know, which is why `source` required a new version.

`reobserve` and `abstain` are always present. `progress` is structured: the
action and decision counters plus `performedSteps`, a map from a target's stable
identity to how many times this run performed it — the runner counts its own
successful actions and never trusts the app for the count.

## Per-step loop

1. `get_window_state` (tree; a screenshot is added only for the visual modes).
2. Code adds facts: frontmost app, focused field, role classes, source tags,
   rows of repeated labels, and the actions already tried on this screen.
3. Build the bounded candidate table from the sources.
4. One `cua.jev_choice_request_v2` request → one `selected_id`.
5. **Confirm when the step mutates something risky.** A candidate whose label
   names a hard-to-undo action is executed only after the user confirms, **every
   time**. An escalated mutating candidate — the foreground twin of a background
   route the driver refused — asks once per target and then runs without asking
   again: background delivery being refused is systematic in some apps (Electron
   among them), and re-asking for every click makes the tool unusable, while a
   genuinely destructive action is worth re-confirming. With no UI to ask, the
   run stops as `needs_review` instead of acting. The risk table is a gate on the
   offer set, not the only guard.
6. Dispatch the frozen candidate. Background first; on
   `escalation.recommended` offer the next rung as a **separate** candidate on
   the next turn rather than retrying silently — `px` and `foreground` are
   different rungs and stay different candidates.
7. Observe the successor. The successor is the only witness of the action.
8. Stall rules (below) end the turn.

A candidate that was refused, or whose effect was not verified, is excluded by
its stable identity; a candidate known to be on screen but unreachable (its
window has no accessibility surface) never becomes a silent retry loop either.

### Ending a run

`done` is the chooser saying the goal is satisfied, and it is accepted only with
evidence: every prepared text slot must have been delivered, and **both** signals
must be good enough — the chooser's confidence must clear its floor, and, when a
completion prediction was asked for, that prediction must clear its own. A
missing prediction is a signal that is absent, not one that is bad, so a
sufficiently confident `done` still ends the run. A `done` that is rejected is
recorded in the history and **stays on the offer set** — refusing it must not be
the same as forbidding it, or a finished task whose screen no longer changes can
only end as `max_actions`.

The two floors differ because the measured confidence differs: attaching a
screenshot to a request halves it (see Vision below), so the image path gets its
own, lower floor rather than a number that would reject the correct answer.

## Stall rules

Copied from the upstream jev loop, and the fix for the recorded failure:

- A screen signature is the app, the window title and the observed text, with
the element *position* left out and the semantic state (`selected`, disabled)
left in; two captures are the same screen when at most one line differs. The
index cannot be part of a change test: it is a snapshot-local ordinal, so
inserting one element renumbers every row after it and fakes progress; and a
selection that only changes `selected` has to count as a change, or the correct
target is quarantined for “no effect”.
- **Three actions in a row that left the screen unchanged** → stop with
  `stalled`.
- **Two actions in a row already taken on the same screen** → stop with
  `stalled` (this catches both a no-op click and a cycle through two screens).
- **The same target selected N times in a row** → exclude it from the offer set
  and tell the chooser why (the old engine had no such brake, which is exactly
  how `DOUBLE_CLICK × 8` happened).
- A memory figure a browser appends to a tab title is excluded from the
  signature, since it drifts between two captures of one screen.

When more than one line changes every step, the loop errs toward running on:
it never stops a run that is making progress.

## Vision (optional, off by default)

Jev 1.14 accepts images (`TypeSafe-Danger-Zone-Images: true` plus an `assets`
map), and its strength with them is **discrimination among bounded options**,
not localisation. `ORBIT_CU_VISUAL=1` attaches the window screenshot to the
choice request, so the answer is still a candidate id and the action is still an
exact snapshot-bound `element_token`.

Measured on one real window and goal (`打开右上角的设置`):

| | text only | with screenshot |
|---|---|---|
| chosen candidate | `button "设置 (⌘,)"` | same |
| confidence | **0.97** | **0.59** |
| input tokens | 14,541 | 32,258 |
| latency | 1,597 ms | 1,300 ms |

Same answer, half the confidence, more than double the input. So the screenshot
is attached only where a picture can change the answer — `auto`, the default for
`ORBIT_CU_VISUAL=1`: an unlabelled target is in the offer set, or the previous
choice was below 0.6 confidence. `ORBIT_CU_VISUAL=always` exists for A/B
measurement, not production.

`Box` questions (coordinate grounding) were measured and rejected: on a field
the accessibility tree locates exactly, `Box` reported confidence **0.35** with
wrong coordinates, while the `noul` presence answer on the same image was 0.96.
A picture is worth attaching to *choose among our candidates*; it is not a
substitute for the tree as a locator.

Service limits are enforced before sending, never worked around: 256–1568 px per
side and 78,400–2,458,624 total pixels. The driver caps the long edge itself
(`max_image_dimension`), so no local resampling is needed and the click/type
coordinate space stays the one the image came from. An out-of-range capture is
skipped rather than sent.

The perception extension (`parse_visual_regions`, OmniParser) is a **different**
thing: text/icon regions, **AGPL-3.0-only**, not installed and not bundled. It is
reachable behind `ORBIT_CU_VISUAL_REGIONS=1` for anyone who installs it, and the
loop degrades silently to `ax` when it is absent.

## Text slots and privacy

Unchanged from today. Exact text lives only in local `textSlots`; the chooser
sees the slot `id` and its short purpose, never the value. `redactLocalSlots`
runs over every description, criteria and observation before the request.
Credential fields are never typed.

## Verification

Every mutating step is verified against the successor observation, not against
the action's return value:

- Text: **that** element's `value` in the successor tree must contain the
  prepared text — the element is found again by its token (or stable identity),
  not by searching the whole tree, because a substring anywhere is how typing
  into the wrong field counts as success. An element that is gone from the
  successor (navigated away) is *unverifiable*, not failed.
- Toggle/selection: the element's `selected` / `value` must reach the requested
  state.
- Navigation/overlay: the successor `window`/`surface` must match the step's
  expectation, and an unexpected overlay is dismissed and recorded.

A step whose verification fails is quarantined by stable target identity, so it
is not offered again. Delivered-but-unverified steps stop the run as
`needs_review`; never-delivered steps are candidate-specific and the loop
continues.

## Module layout (new)

```text
src-tauri/resources/computer-use/
  cua/                     the driver boundary (no MCP)
    errors.ts              DriverToolError / DriverUnavailableError
    tool-result.ts         transport-neutral ToolResult
    binary.ts              resolve cua-driver, assert the grants
    tool-client.ts         `cua-driver call` executor + session label
    driver.ts              typed wrappers over the driver's tools
    observation.ts         element rows -> compact table + screen signature
    types.ts               CuaCandidate / CuaObservation / operation vocabulary
  candidates/
    roles.ts               raw platform role -> closed role class
    policy.ts              risky-label gate, readOnly, offer-set bound
    sources.ts             ax + visual candidate builders, stable ids
  choice/
    contract.ts            cua.jev_choice_request_v2 + strict validation
    jev.ts                 SystemOne chooser (+ completion prediction)
  loop/
    engine.ts              observe -> choose -> act -> verify
    stall.ts               screen signature, stall rules, repeat brake
  gui-task.ts              the gui_task tool (picks the engine)
  gui-task-engine.ts       legacy ax_control engine (ORBIT_CU_ENGINE=legacy)
```

The engine is chosen by `ORBIT_CU_ENGINE`: `cua` (default) or `legacy`. The
visual fallback additionally needs `ORBIT_CU_VISUAL=1`, because it requires the
optional perception extension.

## Prerequisites

1. **CuaDriver.app installed and granted.** The daemon holds Accessibility and
   Screen Recording; the runner cannot obtain them.
   ```sh
   /bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
   open -n -g -a CuaDriver --args serve
   cua-driver permissions grant
   cua-driver check_permissions   # accessibility + screen_recording must be true
   ```
2. **The perception extension is optional and AGPL-3.0.** `cua-perception`
   bundles an OmniParser detector licensed **AGPL-3.0-only**. It is not part of
   the default driver and is not installed by this project. Orbit must not
   bundle it in a distributed build without a licensing decision; the visual
   `source` stays behind a runtime check that degrades to `ax` only when the
   extension is absent (`parse_visual_regions` returns `not_installed`).

## Migration

`ORBIT_CU_ENGINE=cua` (default) runs this engine; `ORBIT_CU_ENGINE=legacy` runs
the old `ax_control` path. The legacy engine and worker stay in the tree until
parity is confirmed on real tasks, then the following are deleted:

`ax.rs`, `fast_ax.rs`, `ax_worker.rs`, `ax_settle.rs`, `crates/computer-use-core`,
`desktop-observation.ts`, `gui-task-engine.ts`, `desktop-driver.ts`,
`xa11y-client.ts`, `jev.ts`, `affordance-memory.ts`, `tree-diff.ts`,
`desktop-app-resolver.ts`, `scripts/sync-worker.mjs`.

## Status

Implemented and covered by tests: the CLI executor and session handling, the
typed driver wrappers, observation shaping (signature without positions,
selection/disabled state), role classes, candidate sources (ax + visual + menu),
the policy gate, the confirmation gate, the v2 choice contract and its strict
validation, the chooser, the loop, target-bound verification, the ending rules,
and both stall rules. Driver permissions are asserted once at connect instead of
being inferred from the first tool error.

Not done: the perception extension is not installed, so the `visual` source has
never been exercised against real pixels — it degrades to `ax` (and the loop
stops asking for the rest of the run once it has been told so). A `px`
(pointer-route) twin is only offered when its coordinates are bound to a
`capture_id`; without one it is not offered at all, because a coordinate that
leaves its capture cannot be executed and offering it would be an always-failing
candidate. The CuaDriver window rows carry no focused/main flag (only
`window_id`, `title`, `pid`, `app_name`, `is_on_screen`, `bounds`, `z_index`), so
the driven window is still chosen by area; if that flag ever appears, it should
win.

## Verification commands

```sh
# driver health (not a model call)
cua-driver check_permissions
cua-driver call list_apps

bun test tests/computer-use-cua.test.ts tests/computer-use-cua-loop.test.ts
ORBIT_CU_LIVE=1 bun test tests/computer-use-cua.test.ts   # needs a GUI
bun run check:computer-use
```
