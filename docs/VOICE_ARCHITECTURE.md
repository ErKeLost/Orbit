# 语音：整通在 Rime Prism，Jev 只判要不要交给 Pi

设计日期：2026-11-21。2026-11-24 清理：ElevenLabs Speech Engine 那条管子（`tools/speech-engine`、`src-tauri/src/elevenlabs.rs`、`speech_engine_*` 命令）已整体删除，现行代码只有 Rime Prism。

## 一句话

麦、断句、打断、闲聊、出声都走 Rime Prism。它自己判断人说完没有，不在这边再做一套 VAD。Rime 做不了的，按 prompt 自己说一句，点出正在查的那件事，再把这通电话的上下文交给 Pi。那句话不写死。没有桌面会话就开一条。做完的结果回到 Rime，由 Rime 念出来。挂断只关麦。

Prism 现在只做英语。中文不是这条链路能补的。

不用 Realtime，不用 LiveKit，不恢复短语表，没有本地管子进程。

## 不碰默认的那条 Pi

输入框发消息、切会话、重连，都还走现在这条。语音不改这些命令的实现。

不改 `connect`、`new_session`、`switch_session` 的实现，不改 Composer 的发送，不改会话启动参数和系统提示，不挂 `before_agent_start`，不写 `gui-session-profile`，不给普通会话加一套语音人设。

语音要动那条会话时，只调界面已经在用的命令：`sendPrompt`、`deliveryFor`、`answerDialog`、`changeSession({ type: "new_session" })`，以及对绑定连接的 `{ type: "abort" }`。没有桌面会话时才开一条。正文带上这通电话的上下文，会话自己不知道这句话来自麦克风。

```
麦（16 kHz PCM，不做 VAD）
              │
              ▼
   src-tauri/src/rime.rs ──WSS──► prism.api.rime.ai
   （key 只在这里）      ◄──      STT + 断句 + 打断 + TTS
              │ 事件：听写 / 开口 / 工具请求
              ▼
   src/features/voice（球、字幕、开麦/静音/挂断）
              │
              ▼
   桌子：handoff.ts + gate
        speak     → 没有工具的嘴，当场答
        dispatch  → 原话一条，发给绑定的桌面会话
        watch     → 读这条会话的投影，念，不发消息
        confirm   → 只回答已经播报过的确认
        control   → 别念了 / 挂断 / 停掉
              │
   orbit-turn-settled / orbit-session-needs-input（绑定的那条）
              ▼
   播报：通话还在就让 Prism 念；人已经挂了就 rime_speak 本地念
```

## 为什么是 Rime，不是 Realtime

Realtime 更快，但脑子是他们的模型。Pi 只能做成它自己决定要不要调的工具，做完也不会叫人。Jev 插不进开口之前。

Rime 好用，是因为它只做耳朵和嘴。派发、旁观、做完了再念，都在这边，而且念的是桌面上那条真会话。断句、回声、PCM 由 Prism 负责，这边不自己写 VAD。

上一代 ElevenLabs Speech Engine 要求本地常驻一个管子进程（`tools/speech-engine`）、一条 Cloudflare 隧道和一个 `seng_…` engine id。它做不到「说完随时开第二句」，也不该由桌面去养第二只看不见界面的 Pi，所以整条删掉，职责改由 `rime.rs` + `handoff.ts` 承担。

## 职责

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| 通话 | `src/features/voice/hooks/useVoiceCall.ts`、`model/call.ts` | 球、字幕、开麦/静音/挂断。应用级单例：切面板不挂电话 |
| 麦与放音 | `model/prism-mic.ts`、`model/pcm-player.ts` | 连续 16 kHz PCM 上送；回声消除与降噪交给浏览器 |
| 后端 | `src-tauri/src/rime.rs` | 持有 Prism 的 key 与 socket，转发听写、截断、nudge、hold、tool result；key 不进 webview |
| 桌子 | `model/handoff.ts`、`model/desk.ts`、`model/binding.ts` | 绑定焦点、判分类、派发、回答确认、播报 |
| 分类 | `src-tauri/src/voice_gate.rs` | 一次 SystemOne（Jev），回答这通通话该走哪条 |
| 本地嘴 | `model/desk.ts` 的 `speakOut` | 通话已断时用 `rime_speak` 念一句，不依赖 WebRTC |

`voice_gate.rs` 原来长在 `elevenlabs.rs` 里，清理时搬出来单独成文件：它与 ElevenLabs 无关，只是 Jev 的一次分类调用，现役链路一直在用。

## 绑定

开麦时记下当时的 `{ connectionId, sessionFile, cwd }`。这一通就盯这一条。

- 开麦会新开一条会话（`beginFreshVoiceSession`），不复用屏幕上那条：语音的上下文和手打的那条分开。
- 中途人在界面上换了会话，不跟着换。否则一句话会派进另一条。
- 开麦时没有活着的桌面会话：先不派闲聊。Rime 叫 `ask_agent`，或 Jev 判定这句需要结果时，才在当前项目开一条普通会话。不拉 `--no-session`。
- 交给 Pi 的正文带上这通电话已经说过的几句，不只是最后一句。Pi 的最后一段写给朗读。
- 换焦点是以后的一句明确指令，这一刀不做。

## 播报

这是可以不看屏幕的原因。

只盯绑定的那条连接：

- `orbit-turn-settled`：这一轮停了。`aborted` 念「停了」。`error` 念失败，不念堆栈。否则拿最后一条助手回复，让嘴收成一两句，不念代码、日志、清单。
- `orbit-session-needs-input`：有一个 `confirm` / `input` / `select` 等着人。念那个问题，并记下 `request.id`。没有这个记录，「可以」不是确认。

通话还开着：让 Prism 念（`hold` / `nudge` / tool result 走 `rime_prism_*`），始终是一张嘴，回声消除还在 Prism 那边。字幕里不要把这条显示成用户说的话。

人已经挂了：仍要念。走 `rime_speak` 本地 TTS，不依赖这通 WebSocket。挂断取消的是麦，不是播报队列。

## 派发和确认

派发用现成的 `sendPrompt` / `deliveryFor`，不另写一套队列。

- 会话空闲：`{ type: "prompt", message: 用户原话 }`。
- 会话在跑，这句是在改当前任务：`streamingBehavior: "steer"`。`deliveryFor` 发现其实没在跑，会退化成 prompt。
- 会话在跑，这句是下一件：`streamingBehavior: "followUp"`。
- 问不到 pi 在不在跑：按 `deliveryBehavior` 现有的规则，当成在跑。不要猜。

消息正文只有用户原话。不包系统提示，不写 `voice_session`，不要求这条桌面会话改成口语。长答案留在会话里；念出来的是嘴的摘要。

确认用 `answerDialog(request, answer, connectionId)`。只对已经播报过的那个 `request.id`。取消是 `{ cancelled: true }`，同意是 `{ confirmed: true }`，其余把原话放进 `{ value }`。

「停掉」是对绑定连接发 `{ type: "abort" }`。不用 `stop()`：那个会清队列再把 steering 重放回去，语音里的停不是这个意思。

## 失败

| 看到的 | 原因 | 说什么 |
| --- | --- | --- |
| 开麦就失败 | `rime_config` 没有 key | 让他去设置里填 Rime key |
| 接通了但一句都不出声 | Prism socket 断了 | 说断开，不编回答 |
| 说完一直安静 | Jev 没给分类，或 gate 超时 | 走 speak：当场答，不派活 |
| 挂断后没有声音 | 播报队列被挂断清掉 | 这是缺陷。挂断只关麦 |

## 明确不做

- 把闲聊送进桌面会话。只有 Rime 做不了的才交给 Pi。
- 短语表。分类只来自 Jev 的一次回答；代码只卡阈值。
- 再养一只通话专属 Pi，或改默认开会话、普通对话那条 Pi 的启动和系统提示。
- 本地常驻语音服务、隧道、engine id（上一代 Speech Engine 的做法，已删除）。
- 语音里切换到另一条会话。下一刀再做，做的时候也是明确指令，不跟随界面焦点。
- 主动把进度一段段念出来。这一刀只念结束、失败、和需要人回答的确认。人要进度，走 watch。

## 验证

- 一通电话的进程列表里没有额外的 `pi` 工人，也没有本地语音服务进程。
- 「你好」之后，绑定会话的消息数不变。
- 「把登录改成失败三次锁定」之后，绑定会话多一条，正文等于这句原话。界面先听到「我查一下…」，麦可以继续说。
- 这轮跑完、人没再说话：念一两句结果。挂断后跑完：仍念。
- 「做到哪了」不增加会话消息。
- 没有待确认时说「可以」，不调用 `answerDialog`。
- 「别念了」只停声音。「停掉」才 `abort`，而且不重放队列。
- 没开麦时，新会话和输入框发消息走的仍是原来的 Pi。
