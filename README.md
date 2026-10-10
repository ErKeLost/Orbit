# Orbit

桌面的 Orbit 工作台：Tauri 2 + Vite + React + Motion + TanStack Query + Zustand + Iconify + assistant-ui。使用真实 Pi RPC 和 SDK，不是模拟聊天界面。

## 运行

```sh
git clone https://github.com/ErKeLost/Orbit.git
cd pi-gui
bun install --frozen-lockfile
bun run tauri dev
```

项目通过 `bun.lock` 和 `packageManager: bun@1.4.2` 固定 Bun 与依赖。项目同时安装了 Bun 1.4.2 的官方包；如系统 Bun 版本较旧，可用 `./node_modules/.bin/bun` 执行上述命令。Node 仍用于启动 Pi 的官方 Node CLI。

`bun run tauri` 调用安装在项目中的 Tauri CLI；若本项目已有独立 Rust 工具链，启动脚本会使用它。新机器请按 Rustup 官方说明安装 Rust，仓库的 `rust-toolchain.toml` 固定当前稳定版 1.98.1。

```sh
bun run check
bun test
bun run check:android    # aarch64-linux-android 的 Rust + 手写 Kotlin，需要 NDK
bun run check:intel      # x86_64-apple-darwin 的 Rust（orbit + ax_control）
bun run test:pi           # 实际 Pi RPC / 扩展 / Bash 集成，不发送模型请求
bun run test:pi --live    # 增加一次真实中转模型请求
bun run tauri build --bundles app
```

`bun run check` 与 `cargo check` 都只编译**宿主机**目标。两个已发布的目标因此都在它们的
视野之外：`#[cfg(target_os = "android")]` 里的代码和 `src-tauri/gen/android` 下手写的
Kotlin（要在 Android 任务里才编译），以及 `x86_64-apple-darwin`（要在 Release 的 Intel
任务里才编译）——那趟 CI 是 45 分钟。`bun run check:android` 和 `bun run check:intel`
就是本地把这几半各编译一遍（Android 的 Rust 约 30 秒、Kotlin 首次约 1 分钟，Intel 首次
约 2 分钟），避免为了一个笔误等一轮 CI。`check:android --rust-only` 可以只跑快的那个。

Intel 那条需要先 `rustup target add x86_64-apple-darwin`；脚本会提示。

`bun run dev` 仅运行浏览器预览，原生能力需要桌面 App。

## 使用

启动后发现本机 Pi，并连接所选目录；默认沿用你已有的 Pi Provider、模型与推理强度配置。通过设置切换项目目录。会话与凭据仍由 Pi 保存，API Key 不进入这个仓库。

- `⌘N`：新会话；`⌘,`：设置；`⌘B`：侧栏。
- 文件面板默认可编辑：打开即打字，`⌘F` 打开查找框（`Aa` / `ab` / `.*`、命中计数、↑↓ 跳转、Enter / Shift Enter），`⌘S` 保存到磁盘，`⌘Z` 撤销每文件独立的草稿。未保存的文件在标签上有小圆点，关闭标签不会丢掉修改——重新打开还在。高亮用 shiki，和预览同一套 theme；相同的对话界面在手机上也能编辑并保存到电脑（保存按钮在底部），见 [docs/EDITOR.md](docs/EDITOR.md) 与 [docs/MOBILE.md](docs/MOBILE.md)。`⌘⇧F` 是跨文件搜索（和 `⌘K` 同一个面板）。
- 空闲时 Enter 发送，Shift Enter 换行；运行中可选择引导或跟进，再点击排队箭头。
- 模型和 effort 下拉框只展示 Pi 实际报告的可用项。
- 会话树支持导航、分叉、标签；设置可控制工具和压缩；控制台包含全部 33 个 RPC 命令。
- `⌘` 侧栏 →「屏幕」：手机端实时看桌面并直接触控、打字、发快捷键；桌面端显示屏幕通道状态、编码格式与授权。桌面用 VideoToolbox 硬编 H.264（静止画面只花几百字节），手机端用 WebCodecs 解码，无 WebCodecs 时自动退回 JPEG。帧走独立连接，不与对话争带宽。见 [docs/SCREEN.md](docs/SCREEN.md)。
- OAuth、包管理及终端专有扩展从设置里的原始 Pi 终端入口使用。

完整功能边界与 33/33 RPC 覆盖：[CAPABILITIES.md](docs/CAPABILITIES.md)。文档与代码依据：[SOURCES.md](docs/SOURCES.md)。精确版本：[versions.json](docs/versions.json)。实际集成结果：[pi-smoke-result.json](docs/pi-smoke-result.json)。

应用目前验证目标是本机 macOS；没有宣称任意 Pi 终端扩展都可移植。macOS 桌面构建采用 ad-hoc 签名且未公证：首次安装需右键放行一次。电脑操作的辅助功能授权给「Orbit Agent」运行时（签名稳定），应用内更新不会丢失授权，详见 [docs/RELEASES.md](docs/RELEASES.md)。

### Tauri 命令

这是 `create-tauri-app` 官方生成的 `src-tauri` 项目。项目脚本同时提供：

```sh
bun run tauri:dev    # 使用项目固定工具链启动桌面开发 App
bun run tauri:build  # 使用项目固定工具链打包 App
bun run tauri:info   # 官方 CLI 环境信息
bun run tauri --help # 直接调用本地 @tauri-apps/cli
```

`tauri` 保持为官方 CLI 的裸命令；`tauri:dev` 与 `tauri:build` 使用 `scripts/tauri.mjs` 设置仓库锁定的 Rust 1.98.1，避免系统 Homebrew Rust 版本过旧。
