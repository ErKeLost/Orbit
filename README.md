# Orbit

桌面的 Orbit 工作台：Tauri 2 + Vite + React + Motion + TanStack Query + Zustand + Iconify + assistant-ui。使用真实 Pi RPC 和 SDK，不是模拟聊天界面。

## 运行

```sh
git clone https://github.com/ErKeLost/pi-gui.git
cd pi-gui
bun install --frozen-lockfile
bun run tauri dev
```

项目通过 `bun.lock` 和 `packageManager: bun@1.4.2` 固定 Bun 与依赖。项目同时安装了 Bun 1.4.2 的官方包；如系统 Bun 版本较旧，可用 `./node_modules/.bin/bun` 执行上述命令。Node 仍用于启动 Pi 的官方 Node CLI。

`bun run tauri` 调用安装在项目中的 Tauri CLI；若本项目已有独立 Rust 工具链，启动脚本会使用它。新机器请按 Rustup 官方说明安装 Rust，仓库的 `rust-toolchain.toml` 固定当前稳定版 1.98.1。

```sh
bun run check
bun test
bun run test:pi           # 实际 Pi RPC / 扩展 / Bash 集成，不发送模型请求
bun run test:pi --live    # 增加一次真实中转模型请求
bun run tauri build --bundles app
```

`bun run dev` 仅运行浏览器预览，原生能力需要桌面 App。

## 使用

启动后发现本机 Pi，并连接所选目录；默认沿用你已有的 Pi Provider、模型与推理强度配置。通过设置切换项目目录。会话与凭据仍由 Pi 保存，API Key 不进入这个仓库。

- `⌘N`：新会话；`⌘,`：设置；`⌘B`：侧栏。
- 空闲时 Enter 发送，Shift Enter 换行；运行中可选择引导或跟进，再点击排队箭头。
- 模型和 effort 下拉框只展示 Pi 实际报告的可用项。
- 会话树支持导航、分叉、标签；设置可控制工具和压缩；控制台包含全部 33 个 RPC 命令。
- OAuth、包管理及终端专有扩展从设置里的原始 Pi 终端入口使用。

完整功能边界与 33/33 RPC 覆盖：[CAPABILITIES.md](docs/CAPABILITIES.md)。文档与代码依据：[SOURCES.md](docs/SOURCES.md)。精确版本：[versions.json](docs/versions.json)。实际集成结果：[pi-smoke-result.json](docs/pi-smoke-result.json)。

应用目前验证目标是本机 macOS；没有宣称任意 Pi 终端扩展都可移植。macOS 桌面构建用仓库固定的自签证书（`bun run signing:setup` 生成）签名，未公证：首次安装需右键放行一次，应用内更新不再丢失辅助功能授权，详见 [docs/RELEASES.md](docs/RELEASES.md)。

### Tauri 命令

这是 `create-tauri-app` 官方生成的 `src-tauri` 项目。项目脚本同时提供：

```sh
bun run tauri:dev    # 使用项目固定工具链启动桌面开发 App
bun run tauri:build  # 使用项目固定工具链打包 App
bun run tauri:info   # 官方 CLI 环境信息
bun run tauri --help # 直接调用本地 @tauri-apps/cli
```

`tauri` 保持为官方 CLI 的裸命令；`tauri:dev` 与 `tauri:build` 使用 `scripts/tauri.mjs` 设置仓库锁定的 Rust 1.98.1，避免系统 Homebrew Rust 版本过旧。
