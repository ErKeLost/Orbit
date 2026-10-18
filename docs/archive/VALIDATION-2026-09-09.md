> 历史记录，非当前状态。以下内容只描述 2026-09-09 当天的验证结果，不代表当前代码。

# 验证记录

日期：2026-09-09，本机 macOS arm64。

- Bun 1.4.2：`bun install --frozen-lockfile` 成功。
- `bun run check`：TypeScript 7.0.2 与 Oxlint 检查通过。
- `bun test`：5 个事件/历史消息回归用例通过，覆盖 delta-only 增量、最终快照、agent_settled、工具结果替换、Bash/摘要记录和隐藏 custom 消息。
- Rust 1.98.1 / `cargo check`：通过。
- `bun run tauri build --bundles app`：成功生成 release macOS App。
- 实际 Pi RPC 测试：get_state、模型/effort 列表、扩展工具开关、Bash、命令枚举均通过；真实中转回复“Pi GUI 连接测试成功。”，见 pi-smoke-result.json。
- 浏览器 UI：检查布局、输入提示和控制台导航；捕获的浏览器 error/warn 日志为空。浏览器模式明确显示仅预览，不假装连接本机。
- 已运行桌面的 Pi GUI.app，并确认其启动了子进程 Pi。没有把这一进程检查描述成对全部原生窗口交互的自动化验证。
- 47 项直接 JS 依赖均与 2026-09-09 注册表 latest 稳定版本一致。传递依赖遵守上游兼容约束并保存在锁文件中。

## 验证范围之外

- 未逐个运行第三方扩展或其终端自定义 UI；限制记录在 CAPABILITIES.md。
- 未对其他操作系统、公开分发签名/公证、多实例并发运行做完整验收。
- 构建报告主 JS bundle 约 814 KB（gzip 约 250 KB），仍有 Vite 的 chunk-size 提示；它不是构建错误。

## 本次组件与观测更新验证

- TypeScript 构建通过；Bun 9 个用例通过，新增压缩状态、取消/失败、补丁来源与多目录去重测试。
- Rust 原生进程测试通过：停止项目 A 后项目 B 子进程保持运行。
- 实际 Pi SDK 观测命令通过，读到压缩配置及系统提示词。
- 当前 jamerly provider 的 OpenAI 兼容 `/v1/models` 实测返回 HTTP 200 和 15 个模型；API key 只在 Rust 请求中使用，未返回前端。
- 真实压缩集成通过：以 SDK 写入明确标记的合成测试会话，由真实中转模型生成摘要；收到 compaction_start / compaction_end，1,384 tokens → 估算 467。随后 contextUsage.tokens / percent 都为 null。完整记录见 compaction-verification.json。
- 浏览器独立组件测试页验证 LobeHub Markdown、表格、高亮、公式、Pierre 并排/统一切换、组件弹出菜单以及压缩开始/结束界面；浏览器 error 日志为空。该测试页不属于正式应用入口，测试数据不冒充用户会话。
- 最新 `.app` 已重新打包、替换桌面副本并启动；没有进行新的浏览器测试，按本次需求只执行终端、Pi RPC、Rust 和生产构建核验。
- 性能检查：`message_update` 与 `tool_execution_update` 按 32 ms 批量提交；消息行按实际 `toolCallId` 做 memo 比较，App 使用 Zustand 精确 selector。这样保留流式反馈，同时避免每条增量让全部历史 Markdown 重渲染。
