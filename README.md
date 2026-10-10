<p align="center">
  <img src="public/orbit-mark.png" alt="Orbit" width="88" />
</p>

<h1 align="center">Orbit</h1>

<p align="center">
  <strong>跑在自己电脑上的 Personal Agent。</strong>
</p>

打开项目文件夹，选一个 agent，开始干活。会话就是标签页，可以拆开并排；文件、终端、diff、笔记都在同一个窗口里，越用越顺手。

- **会话**：标签页即会话，可拆分并排；按项目归档，支持 worktree 并行、会话树与分支。
- **模型与工具**：切换模型和 thinking 档位，读中转站的完整模型目录；工具、技能、MCP、Codemode 都沿用本机 Pi 的配置与凭据。
- **常驻的部分**：自动化任务、computer use（本机 GUI 操作）、图片生成与分类，以及随应用打包的运行时。

用自己的订阅或 API Key，本地运行，不卖 token。

## 快速开始

需要 Node 20+、Bun 1.4+、稳定版 Rust，以及装好并登录的 Pi。

```bash
bun install
bun run tauri:dev     # 开发
bun run tauri:build   # 打包
```

更多能力与边界见 [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md)。

## Credits

Orbit 的界面与交互基座来自 [MonoCode](https://github.com/hardbeat920/monocode)，由 [@hardbeat920](https://github.com/hardbeat920) 创建（MIT，Copyright (c) 2026 Nick）。`monocode/` 保留了上游源码与其 NOTICE 中的声明；UI 中出现的第三方产品标识仅用于说明可驱动的 agent，归各自所有者所有。

