<p align="center">
  <img src="public/orbit-mark.png" alt="Orbit" width="88" />
</p>

<h1 align="center">Orbit</h1>

<p align="center">
  <strong>基于 MonoCode + Pi 打造的 Personal Agent。</strong>
</p>

<p align="center">
  本地优先的桌面 Agent 工作台 · Tauri 2 + React 19 + Pi Runtime
</p>

---

## 这是什么

Orbit 是一个跑在自己电脑上的 personal agent。它的界面基座来自 [MonoCode](https://github.com/hardbeat920/monocode)（一个给编码 agent 用的 GUI），agent 运行时来自 [Pi](https://github.com/earendil-works/pi)。

一句话概括：**MonoCode 提供「人怎么用」这一层，Pi 提供「agent 怎么跑」这一层，Orbit 把它们拼成一个只属于自己的常驻助手。**

- **MonoCode 那一半** — 标签页即会话、可拆分窗格、项目/工作区组织、文件树与 diff 审阅、终端、笔记、收件箱、设置页，以及那套已经打磨过的输入框（composer）。这些是交互与信息架构，直接复用，不重复造。
- **Pi 那一半** — 模型、工具、技能（skills）、MCP、压缩、会话树、扩展系统，全部走 Pi 自己的配置与 RPC，不另起一套。
- **Orbit 自己加的部分** — 常驻的 personal agent：跨项目的记忆与自动化任务、computer use（可以是本机 GUI 操作）、图片/分类器等生成能力，以及一个把 Pi 运行时随应用打包、由 Rust 侧托管的桥接层。

所以 Orbit 不用 token 中转、不卖额度：你用自己的订阅或 API Key，装完就能跑。

## 设计取向

| 取向 | 含义 |
| --- | --- |
| 本地优先 | 会话、密钥、模型配置都留在本机（复用 Pi 的 `models.json` / `auth.json`），前端拿不到明文 Key |
| 复用而非重写 | 能用 Pi 官方 RPC / SDK / extensions 解决的，就不在 GUI 里再实现一遍 |
| 不与终端为敌 | OAuth 登录、TUI 专有交互这类 RPC 边界外的事，直接拉起原生 Pi 终端，而不是假装支持 |
| 配置即数据 | 例如生成能力的参数表、模型尺寸表都写在配置文件里，加模型不用改代码 |

## 主要能力

- **会话与项目**：每个标签是一个会话，可拆分并排；按项目归档，支持 worktree 并行、新建/恢复/命名/克隆/分叉、会话树导航。
- **聊天体验**：流式 Markdown、代码块、图片、thinking 过程、工具卡（参数 / 部分结果 / 最终结果）、Bash 实时输出。
- **模型**：切换模型与 thinking effort，读取中转站的完整模型目录，沿用 Pi 已有的 reasoning / 兼容性覆盖。
- **工具与扩展**：Pi 的 33 个官方 RPC 命令都有类型安全的入口；技能、提示模板、扩展命令走命令面板；MCP 支持 stdio 与 streamable HTTP；Codemode / Tool Search 可在设置里开关。
- **Personal agent**：自动化任务（automations，带调度器与模板）让 agent 在你不盯着的时候自己干活；笔记、收件箱、跨项目会话把产出归拢到一处。
- **Computer Use**：基于 macOS Accessibility API 的本机操作，配合本地有界决策模型，不把整屏截图丢给云端。
- **生成能力**：图片生成、分类器等按「能力（kind）」配置，端点和密钥自填，一次调用按实际选中的模型校验参数。
- **其他**：编辑器、文件/文件夹视图、source control、终端、笔记、收件箱、搜索、移动端配对。

完整覆盖范围与每一项的实现依据见 [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) 和 [`docs/SOURCES.md`](docs/SOURCES.md)。

## 架构

```
┌─────────────────────────── Orbit (Tauri 2) ───────────────────────────┐
│  React 19 + Vite + TypeScript        前端：会话 / 编辑器 / 设置        │
│        │  invoke / Channel (src/lib/rpc.ts)                           │
│  Rust 桥接 (src-tauri/src/bridge.rs) 进程、资源、Key、asset protocol   │
│        │                                                              │
│  Pi Runtime (src-tauri/resources/pi-runtime, vendor/, bundle-pi.mjs)  │
│        └── RPC 会话 · SDK · 扩展 (gui-extension.ts) · subagents        │
└───────────────────────────────────────────────────────────────────────┘
```

- 前端只跟 Rust 说话，密钥与 Pi 配置只存在于 Rust 进程侧。
- 流式数据走 Tauri Channel；协议是 Pi 的 LF 分帧 RPC 事件。
- `src/features/*` 按领域切分：`chat` / `sessions` / `projects` / `files` / `settings` / `computer-use` / `automations` …

## 快速开始

**前置**：Node 20+、Bun 1.4+、稳定版 Rust 工具链，以及至少一个已登录的 agent（Pi）。

```bash
bun install
bun run tauri:dev        # 开发
bun run tauri:build      # 打包
```

常用脚本：

| 命令 | 作用 |
| --- | --- |
| `bun run check` | 类型检查 + lint + computer-use 同步检查 |
| `bun test` | bun test + vitest |
| `bun run test:pi` | Pi 运行时冒烟测试 |
| `bun run bundle:pi` | 重新打包随应用分发的 Pi 运行时 |

环境变量（构建期注入）见 [`.env.example`](.env.example)。

## 目录结构

```
src/                前端（features / components / integrations / platform）
src-tauri/          Rust 桥接、capabilities、随包资源（pi-runtime、computer-use、subagents）
crates/             computer-use-core 等本地 crate
monocode/           上游 MonoCode 源码（界面基座，MIT）
relay/              移动端/远程配对的 relay
docs/               能力清单、来源核对、编辑器/移动端/多 agent 说明
tests/              跨端测试
```

## 文档

- [能力覆盖与边界](docs/CAPABILITIES.md)
- [文档与代码依据](docs/SOURCES.md)
- [Computer Use](docs/COMPUTER_USE.md) · [多 Agent](docs/MULTI_AGENT.md) · [移动端](docs/MOBILE.md)
- [编辑器](docs/EDITOR.md) · [屏幕](docs/SCREEN.md) · [发布](docs/RELEASES.md) · [自检](docs/VALIDATION.md)

## 致谢与许可

Orbit 建立在其他人的工作之上：

- **[MonoCode](https://github.com/hardbeat920/monocode)** — 界面与交互基座，MIT License，Copyright (c) 2026 Nick。`monocode/` 为其源码，[NOTICE](monocode/NOTICE) 中的商标声明一并保留。
- **[Pi](https://github.com/earendil-works/pi)**（`@earendil-works/pi-coding-agent`）— agent 运行时、RPC / SDK / 扩展协议。
- **[Tauri](https://v2.tauri.app/)**、**[React](https://react.dev/)**、**[assistant-ui](https://www.assistant-ui.com/)**、**[Beautiful UI](https://www.beautifului.dev/)** 等，许可记录见 [`docs/licenses/`](docs/licenses)。

UI 中出现的第三方产品标识仅用于说明可驱动的 agent，归各自所有者所有。
