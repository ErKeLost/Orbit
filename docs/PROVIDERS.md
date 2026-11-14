# Providers and the local Pi runtime

Orbit separates the program that runs the agent from the model endpoints and
accounts that program uses. This follows T3 Code's separation between a driver
configuration, process environment, and authentication state. This version
configures one local Pi runtime; it has no remote-environment selector.

## Local process configuration

Settings → Providers → **Pi 运行配置** provides:

- **Binary path**: empty uses Orbit's bundled Pi 1.5.2. A command on PATH, an
  absolute executable path, or a Node CLI script can be selected instead.
- **Launch arguments**: quoted literal arguments, including `--model`,
  `--provider`, `--thinking`, and extension flags. `--provider` requires
  `--model`. Orbit owns RPC mode and session selection; positional prompts and
  attachments are rejected. API keys belong in sensitive variables.
- **Environment variables**: per-child overrides of the inherited OS environment.
  Each row has a name, value, and sensitive flag. A saved sensitive value is
  returned as an empty value with `valueRedacted: true`; submitting that row
  unchanged preserves its value. Enter a replacement before renaming or making
  it plain text. Deleting a row removes the override.
- **Check runtime**: resolves the executable and checks its version without
  creating an agent session, running project hooks, or starting OAuth.
- **Save / Save and reconnect**: new processes use the saved configuration;
  reconnect applies it to the current workspace. Existing other sessions keep
  their launch environment until they reconnect.

`PI_CODING_AGENT_DIR` selects an absolute Pi configuration directory. Rust's
session index, provider configuration, OAuth helper, and GUI extension use that
same directory. Orbit's own process wiring (`ORBIT_*`, `PI_GUI_*`, `NODE_PATH`,
home and session-root variables) remains managed by Orbit.

The process configuration is stored at `~/.pi/orbit/runtime.json`. Sensitive
values are stored separately in `runtime-secrets.json`, with private file
permissions. Neither values nor key-bearing shell commands are generated in
Terminal history: the packaged terminal launcher reads the private store after
the shell starts it. Values are never installed into Orbit's global environment.

`pi_runtime_settings.rs` owns validation, redaction, and storage. `RuntimePaths`
resolves the command and applies the process environment. The GUI keeps only a
draft and the redacted native projection.

## Accounts and model endpoints

The **订阅与账户** section discovers every OAuth method from the bundled Pi SDK:
Anthropic, OpenAI ChatGPT, OpenAI Codex, GitHub Copilot, Kimi Coding, OpenRouter,
Meta, xAI, and Radius. OAuth does not necessarily imply a paid subscription.

`provider_auth.rs` owns one cancellable login helper at a time. The helper uses
Pi's `ModelRuntime.login/logout`, credential file lock, and stable device ID.
Authorization URLs, device codes, selection prompts, and manual callback input
appear in Orbit. A browser callback can close a manual prompt; closing the dialog
or leaving settings cancels the helper. No access or refresh token is returned to
the webview. Checking saved account state does not refresh tokens.

`auth.json` remains Pi's credential source. API-key writes cannot overwrite or
delete an OAuth credential: sign out first when changing authentication method.
If a built-in provider ID already describes a custom API gateway, keep that
gateway under a separate ID before signing into the built-in account. This keeps
subscription tokens from inheriting an old gateway's transport.

Native Pi models are discovered through the SDK. Saving their default selection
writes `settings.json` without creating placeholder custom models in
`models.json`. Ordinary custom endpoints retain the existing model-catalog editor.

## Magpie

Install and run [Magpie](https://github.com/yetone/magpie) separately, then connect
its gateway in Providers. The default is `http://127.0.0.1:3425`; its loopback
default key requires no input. A custom endpoint can use a saved gateway key.

Magpie manages Antigravity, Gemini CLI, account pools, and routing groups. Orbit
reads `/v1/models` and writes model-specific Pi transports:

| Advertised native endpoint | Pi API | Base URL |
| --- | --- | --- |
| `/v1/responses` | `openai-responses` | `{root}/v1` |
| `/v1/messages` | `anthropic-messages` | `{root}` |
| Other / routing group | `openai-completions` | `{root}/v1` |

The adapter maps `none` to Pi's `off`, hides unsupported effort levels, and
enables adaptive thinking for Claude 4.6 and newer. Gateway models use zero cost
metadata because retail API pricing does not describe a subscription bill.
Allowance cards read `/v1/magpie/quotas?kept=1`, displaying Magpie's cached
remaining percentages and reset times. An unavailable quota endpoint does not
prevent using the model catalog.

## Reference and verification

The T3 Code reference inspected for local process configuration was
[`a185dd9248`](https://github.com/pingdotgg/t3code/commit/a185dd9248):
`packages/provider-pi/src/settings.ts`,
`packages/provider-pi/src/server/mcpInjection.ts`,
`packages/contracts/src/providerInstance.ts`,
`apps/server/src/settingsSecrets.ts`, and the provider environment form.
Magpie's transport mapping follows the published `pi-magpie@0.1.6` contract.

Checks include `bun run check`, `bun run test:providers`, provider UI tests,
Rust library tests, and the existing Pi RPC smoke test. The provider smoke check
copies the packaged runtime into an isolated directory and verifies all nine
OAuth loaders with network requests blocked and synthetic credentials only.
