# references

只读对照。这些目录是 git submodule，不参与 `bun run build` / `cargo build`，CI 也不会检出。

| 目录 | 上游 | 用来对照什么 |
| --- | --- | --- |
| `codex` | https://github.com/openai/codex.git | 多 agent / 协议 |
| `monocode` | https://github.com/hardbeat920/monocode | Orbit UI 的起点 |
| `t3code` | https://github.com/pingdotgg/t3code.git | markdown、浏览器、性能 |
| `browse` | https://github.com/anomalyco/browse.git | OpenCode Browse：扩展 + Rust relay，不是 OpenCode 主仓的 submodule |
| `opencode` | https://github.com/anomalyco/opencode.git | OpenCode 本体。浅克隆 `dev`，只用来对照桌面浏览器和 code mode |
| `agent-browser` | https://github.com/vercel-labs/agent-browser.git | Vercel 的 agent CLI：Rust daemon 直接 CDP |

```bash
git submodule update --init
```

不要在这里改 Orbit 的功能。要改的代码在 `src/` 和 `src-tauri/`。打过补丁、会编译进应用的 crate 在 `vendor/`，不要再混进这个目录。
