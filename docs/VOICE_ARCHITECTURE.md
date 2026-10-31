# Orbit 语音工作助理与浏览器架构

实现日期：2026-10-31。本文描述当前实现；真实麦克风端到端延迟、真实账号登录和原生画中画交互仍需在桌面客户端验收。

## 语音：一个入口，两种职责

开麦时创建并绑定一条**新的后台 Pi session**，不激活工作区，不替换屏幕上的会话，也不触发其加载骨架。创建完成后，通过扩展命令写入 `gui-session-profile` 自定义条目：`{version: 1, type: "voice", language: "en" | "es"}`。每轮 `before_agent_start` 从当前会话读取该类型，为语音会话追加简洁、受支持语言的回复要求（1–3 句，最多 60 个词）；重连后仍有效。普通 Pi 会话没有该条目，不追加这些提示。旁观或向普通会话发送任务不会改写其类型或注入新的简洁指令。

挂断只结束语音资源；已派发的 Pi 任务继续运行，新会话继续保留在会话列表中。

语音页不展示会话选择器或文字输入框。每次开麦都绑定新的后台会话；旁观其他任务可通过语音点名。意图判断和问答服务始终在本次独立语音连接中运行，避免旧连接尚未加载新扩展时将内部服务命令当作任务。所有执行写入均显式指定关注目标的 connectionId 和 sessionFile。

| 组件 | 职责与代码 |
| --- | --- |
| VoiceController | 通话、轮次、焦点、插话、事件订阅和播报优先级；`src/features/voice/model/voice-controller.ts` |
| SpeechInput | opening 音频缓存、尾帧 flush、STT 预热、完整录音兜底、用户轮次内按采集顺序合并分段、过期回调隔离 |
| MicCapture | AudioWorklet 音频线程持续重采样，20ms 帧、160ms 起音前缓存、可调静音断句 |
| Jev 路由服务 | `src-tauri/resources/voice/service.ts`；可信 Pi 扩展内调用，密钥留在后端 |
| CommandGateway | 唯一执行入口；会话身份校验、命令去重、取消检查和实际发送前再校验 |
| TaskView | 从现有 RPC 快照和原始事件派生状态、近期事实、待确认对象；排除 thinking |
| ConversationAgent | 复用模型注册表，以独立短历史、短回答提示和只读任务视图生成流式回答 |
| SpeechOutput | Rime 流式 PCM 播放、小批次文本发送、generation 隔离与取消 |

概念架构图见 [architecture.svg](../diagram/voice-companion/architecture.svg)。这些组件运行在现有桌面应用与 Pi 扩展内，没有新增常驻远程服务。

## 意图、执行与旁观

Jev 在**一次 SystemOne 请求**中并行判断主要职责，以及职责内的投递方式、观察方式、目标、授权、请求完整度和上下文关系。主要出口是 `execute`（交给 Pi）与 `respond`（语音直接回应），另有语音控制、任务取消、切换关注、澄清和已播报的工具确认。查询和操作都由 Pi 完成，不在顶层互相竞争；闲聊和任务分析都由语音回应，通过是否读取 TaskView 区分。代码只解释当前职责对应的子判断。只有存在已播报的工具交互时才提供审批选项；补充城市等普通澄清不属于审批。候选目标最多 30 条，语音历史最多 10 条，不发送整个工作 transcript。

需要新鲜外部证据的问句标记 `workKind: lookup`，与操作任务一样交给 Pi 执行，不能落到没有工具的普通问答里。`workKind` 与 `delivery` 独立，所以“改成查询”仍通过 steer 更新指示，“结束后查询”仍排入 followUp，并保留查询的只读约束。是否需要工具由语义决定，不匹配“天气”“新闻”等关键词。通用知识和闲聊才由独立对话模型直接回答。缺少必要信息时，对话模型针对实际缺项提出一个问题，保留未完成请求和澄清内容，供下一句补充；不反复播放固定菜单。

路由同时接收关注任务的有界只读视图：本轮用户请求、该请求之后的最新回复、执行状态和当前工具。Pi 自己提出的普通追问也能据此承接，避免用户补充一个城市或范围后落入闲聊；前一轮回复不会被当作本轮结果。任务视图不能自行授权新工作。投递判断另有 `unchanged` 分支，高置信度确认范围未变时只建立旁观，不重复投递。内容完整度只约束新工作及查询；任务取消和已经播报的工具确认，分别依靠目标、授权及具体确认对象检查，短回答无需重新描述整项任务。

| 用户话语 | 行为 |
| --- | --- |
| 帮我修登录问题 | dispatch；空闲时启动，忙时 followUp 排队 |
| 别修登录了，先修支付 | 明确 steer |
| 做完以后补测试 | followUp |
| 北京现在天气怎么样 | lookup；交给 Pi 调工具查询，再播报实际结果 |
| 开始一个任务 | 缺少工作内容，先问要做什么；不扫描仓库 |
| 现在做到哪了 | 读 TaskView，Pi 持续执行 |
| 为什么这样做、这个方案有什么缺点 | 独立问答，不进入执行上下文 |
| 继续做，完成告诉我 | 结合任务事实回答，不重复派发 |
| 别念了，任务继续 | 取消声音，继续收音 |
| 不要挂断，我只是让你别念了 | 声音控制由语义判断，不因出现“挂断”关键词而挂断 |
| 把当前任务停掉 | 明确目标后发送 abort |
| 可以 | 没有已说明的待确认对象时作为对话；不自动批准 |

写操作使用独立的置信度和显式写入门槛；门槛是初始校验参数，不是已校准的安全证明。不明确时澄清，不将问题降级成任务。复合请求先由对话模型拆分，再并行逐项交给 Jev，带原始话语验证其含义与时序；执行保持顺序，最后合并回执，避免播报互相打断。

目标绑定保持分类时看到的 sessionFile。状态查询、队列 preflight 和最终发送之间均检查取消与会话身份；停止或切换焦点后，旧路由/转写结果不能投递任务。已发送的任务不会因挂断自动撤销。

旁观直接复用 `rpc-core` 归并前的有序事件订阅，只播报当前关注或明确请求旁观的任务。普通工具输出更新有界事实视图；完成、失败与确认进入有优先级和有效期的播报队列。完成后播报 Pi 的实际回复，并将其加入语音短历史；事件本身不证明目标已经验证。当前没有语义阶段摘要模型或持久事件重放。

## Rime 与延迟

TTS 使用官方 WebSocket v1：`coda.api.rime.ai/ws` 或 `mist.api.rime.ai/ws`，子协议 `rime.v1.json`。同一配置复用一条连接，每次回复使用新 contextId；end 结束上下文，cancel 取消该轮。使用 `SPLIT_STRATEGY_ACCUMULATE_SENTENCE` 接收模型 token；16ms 内合并连续 token 的 IPC 写入，原样保留空格，结束时立即 flush。PCM 采用模型原生采样率：Coda 为 24kHz，Mist v3 为 22.05kHz，直接排入 Web Audio；跨分片的半个 PCM16 样本保留到下一片。正常结束、异常和取消均清理流注册表；连接失败先移出连接池，下一轮重新建立连接，不自动重放已经出声的文本。

STT 每句话一条连接；收音过程中并行发送音频和读取 hypothesis/error/done。开始前可预热，10 秒未用即回收；不能将其作为不限时、多轮 STT 长连接。opening 阶段和最后不足批次的音频均保留。开始识别先等待 `started` 确认再上传；暂时性的连接或服务错误可使用本轮完整录音向 Rime 重试一次。鉴权、权限、参数和并发限制错误直接显示，不重传录音。

断句默认 450ms，可在设置中调整为 200–1200ms。输入采用 AudioWorklet 20ms 帧，旧 WebView 保留 ScriptProcessor 兜底。麦克风与播放设备并行准备，Rime TTS 连接在开麦时预热。

音频流分段和用户轮次分开：20 秒传输上限只轮换 STT 流，后续音频无缝进入下一条流，不能据此派发任务。用户在最终转写返回前继续讲话时仍属于同一轮；每条流的 hypothesis 只替换该流的暂定文本，最终文本按采集顺序合并，全部完成后才发送一条完整消息。较早分段晚返回不会丢弃，重复词不会自行去重；挂断仍取消本轮全部分段。静音断句时间继续由用户设置，已完成的不同轮次不会被事后合并。

首次点击时，在任何配置或 Pi RPC 等待之前，同步请求麦克风并 resume 输入/输出 AudioContext，保留 WebKit 的用户操作授权。设备和后台会话并行准备；会话、内部语音服务及设备全部就绪后才激活断句和转写。配置、会话、服务、设备有独立启动阶段提示与超时；启动可取消。未由用户主动取消的 AbortError 会显示为实际设备错误。取消会关闭 pending AudioContext、停止已授予和迟到的麦克风流，迟到的 Pi 连接只回收本次创建的独立连接。

MicSelector 受 controller.deviceId 控制，枚举设备和组件重新挂载都不提交选择；重复选择同一设备不重启收音。LiveWaveform 使用主采集器的 level，不创建第二条麦克风流，也不随“在想/在说”开关硬件。

Rime STT 当前支持英语和西班牙语，TTS 不含中文。语音对话只使用 Rime，语言取自明确保存的 en / es 设置，不推断系统语言，不提供其他识别或合成后端。输入框的独立听写功能不参与语音通话。Prism 尚未接入：它接管对话模型和轮次，与当前 Jev 路由、自有对话模型及 Pi 执行职责重叠。

设置页提供官方音色目录、即时试听、语速、Coda 前瞻、STT 整理/逐字转写、识别关键词和 Coda 自定义发音词典。词典按 `{spelling, pronunciation}` 发送，只发给支持的 Coda 语言，不发给 Mist。最多 500 项，额外限制编码后 60KiB，确保完整 `start` 消息小于官方 64KiB 限制；完整音标合法性仍由 Rime 校验。切换模型不会删除词典。配置写入串行化，保存响应包含凭据存在状态。

“检查连接”并行执行 STT/TTS 的 `start` → `started` → `cancel`，不发送录音或待合成文本。`ready` 不视为鉴权通过。错误保留 kind、retryable、HTTP status 和 requestId；401 提示核对 Token/账号，不推断余额不足。试听共用正式通话的流式播放组件，结束、切换配置、离开设置页均回收资源。

每轮记录 speech_last_sample、endpoint_detected、stt_final、intent_decided、command_accepted、answer_first_token、tts_first_audio 与 playback_started。内存诊断保留最近 100 轮，包括可用的 TTS requestId。语音文字和路由分数、澄清原因写入对应 session JSONL 的 `voice_turn` 自定义条目，直接问答写入 `voice_reply`；这些条目不进入 Pi 的执行上下文，不保存录音或密钥。当前没有完成真实网络下的端到端 p50/p95 测量。

`bun run eval:voice [重复次数]` 是主动调用已配置 Jev/Clef 的路由评估，不派发任务。当前 24 条样例、两轮共 48 次真实 Jev 调用全部符合预期，路由耗时 p50 为 256ms、p95 为 474ms。覆盖操作、实时查询、普通问答、进度、任务分析、后续工作、改任务、否定、工具确认及追问承接。样例集较小且用于调试，不代表未见话语的准确率；该耗时只包含路由，不是整轮语音延迟。JSONL 记录候选意图、投递置信度和拦截原因，方便继续检查真实使用中的误判。

生产链路人工触发的合成测试：同一配置、同一 WebSocket 两轮短句，首轮含握手首音 1010ms，连接复用后 301ms；第二轮生成的 PCM 经 16kHz 重采样，交给正式 Rime STT 流接口，得到 `Orbit is ready to help.`。这些是当前网络下单次短句观测，不是通话端到端 p50/p95，也不含真人麦克风、Jev 和 Pi 耗时。真实服务连通检查同时确认当前 Token 的 STT/TTS 均可用；不查询或推断余额。

## 浏览器：页面、操作权、显示区域分离

浏览器页面属于窗口，不属于某次任务。每个 Pi session / origin 维护稳定页面，后续任务复用；并发任务得到独立页面。每个任务获取新的 owner，所有观察、导航、输入和执行请求都带确定的 tab / owner；旧 owner 不能释放新任务的操作权。不再退回“当前活跃页”驱动未知目标。

任务结束只释放操作权，保留标签、历史和页面。不同网站的 handoff 不再互相关闭。后台释放不抢用户焦点，用户显式关闭标签才销毁 native view。

打开浏览器直接使用浏览器工具，不绕道操作 Orbit 界面；未指定网站时，真实空白标签就是完整结果，不擅自导航到搜索引擎。空白标签也创建原生视图，不等待不存在的网络加载事件。

侧栏和画中画共享**同一个 native webview**，支持拖动、缩放、窗口边界约束和收回侧栏。`browser-surface.ts` 串行提交位置变更，并用显示区域归属隔离旧隐藏请求。它是应用窗口内的浮动浏览器，不是跨应用的系统置顶独立窗口。

## 浏览器 profile 与登录导入

参考 t3code 的 `BrowserImport`、`Sources`、`ChromiumCookies`、`FirefoxCookies` 与 `browserSurfaceStore` 的边界设计，按 Tauri/WebKit 的 API 实现：

- 来源明确选择 browser/profile；优先读取 Network/Cookies，兼容旧 Cookies。
- SQLite online backup 生成权限受限的一致快照，读完自动清理；不写源浏览器资料。
- 读取数据库 schema；Chromium v24+ 严格校验 host SHA-256 绑定，跳过分区 Cookie；Firefox 按 schema 16+ 将过期毫秒转秒，并跳过容器/隐私隔离 Cookie。
- 不再复制 profile 后启动 Chrome 取 Cookie，避免启动过程迁移、淘汰或覆盖会话。
- 每个来源 profile 使用稳定独立的目标存储。macOS 使用 WKWebsiteDataStore identifier（macOS 14+），Windows/Linux 使用独立 data directory。导入不写应用主页面的默认 Cookie 存储。
- Cookie setter 完成后读回真实目标存储核对，报告 verified / skipped 和有限域名列表；旧版未经该流程的成功报告不会隐藏新的导入提示。
- 导入在所有面板间串行执行，期间暂停原生视图摆放与页面轮询；成功或失败都会恢复。浏览器任务运行时拒绝切换资料。成功后现有页面重载到所选资料，个人/工作来源不混写一个 Cookie jar。
- macOS PBKDF2-SHA1 使用来源浏览器的密码作为 password、`saltysalt` 作为 salt，1003 次迭代。独立已知向量检测参数顺序，避免加解密共用错误函数导致测试假通过。已对本机 Chrome schema 24 的 100 条加密 Cookie 做只读抽样，全部解密并通过域名摘要校验；这不等于网站已确认登录。

Cookie 迁移不包含密码、Local Storage、IndexedDB、设备绑定私钥或网站风控状态；Cookie 写入验证也不等于站点确认登录。CDP fallback 是独立浏览器资料，不自动共享 WebKit 登录；此差异仍保留，不能静默宣称两个引擎账号完全一致。

## 验证与桌面验收

自动验证覆盖身份隔离、延迟结果取消、只读进度、内部命令固定连接、命令去重、opening/尾帧、页面租约并发、PiP 显示权交接和 Cookie 数据库兼容。运行 `bun run check`、`bun run test`、`cargo test --manifest-path src-tauri/Cargo.toml --lib`、`bun run build`。

桌面验收需要：重启载入新 Rust 二进制；开麦观察原会话不闪动；连续派任务/问进度/插话；多个网站及并发 browser_task；PiP 拖动与收回；导入个人/工作 profile 后分别访问实际站点，并在退出重开后检查持久化。真实账号登录、麦克风音质、外放回声和原生视图视觉效果不能由 mock 测试代替。

## 官方资料

- [Rime Coda WebSocket v1](https://docs.rime.ai/api-reference/coda/websocket-v1)
- [Rime 自定义发音](https://docs.rime.ai/platform/phoneme-control)
- [Rime 错误参考](https://docs.rime.ai/docs/errors)
- [Rime 延迟基准](https://docs.rime.ai/docs/latency)
- [Rime STT](https://docs.rime.ai/docs/speech-to-text)
- [Rime STT WebSocket](https://docs.rime.ai/api-reference/stt/websockets)
- [Rime 模型与语言](https://docs.rime.ai/docs/models)
- [Prism 长任务](https://docs.rime.ai/docs/prism/long-running-tasks)
- [TypeSafe SystemOne](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)

## 语音输出策略（1.0.20）

实时识别和合成仅调用 Rime；删除 `sttBackend` / `ttsBackend` / `spokenLang` 兼容配置。通话使用明确保存且相同的 `lang` / `sttLang`（en / es），不根据系统语言推断，也不自动迁移其他供应商设置。独立 TTS 的其他 Rime 语言不代表实时识别支持它们。

Pi 的任务结果、进展、错误、标题、确认问题都是只读证据，不能直接拼接后交给播报。语音对话模型统一用所选语言生成 1–2 句的说明；该模型仍复用当前 Pi 模型注册表，音频服务始终是 Rime。普通对话保持短文本流式输出；语音专属 session 已满足语言、纯文本和长度要求的简短 Pi 回复直接播报，减少延迟并保留原始追问。其他任务事件在生成后校验会话身份、取消状态和确认对象，再播报。转换失败时仅播报固定的所选语言状态，提示在任务会话查看，不朗读原始文本。

对话输出限制为 60 个词及 480 字符，按完整单词发送；非 Latin 字母脚本在生成服务和播放入口被拦截，防止中文证据漏进 en/es 合成。这是脚本检查，并非英语/西班牙语语义检测，所选语言仍依赖模型指令。确认说明若超出预算则要求用户在任务页查看，不能截短后授权；只有完整说明首次实际播放后，原确认对象才可由语音回答。


### 上下文与执行结果

派发 Pi 工作时，除了当前请求，还提供最近 6 条有界语音消息和未解决的请求/追问。Jev 的续接分类不再决定是否丢弃这些用户事实；上下文明确要求只执行当前请求，早先消息和助手建议不能自动授权新操作。对工具确认的文本输入仍原样提交，不添加任务上下文包装。

`TaskView.state = settled` 只表示本轮生成停止，不代表目标完成。Pi 询问缺失信息时，语音直接接着问；不能把追问改说成“任务完成但无法进行”。旁观摘要也接收语音历史，按证据说明当前结果和所缺信息。普通 Pi 会话的系统提示仍仅由其自身类型决定。
