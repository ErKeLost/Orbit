# 语音：耳朵在 ElevenLabs，手在桌面会话

设计日期：2026-11-13。替换 v1.0.36 的「一通电话一只 `pi --mode rpc --no-session`」。

## 一句话

人说话，活派给**开麦时桌面上那条会话**。做完、失败、要确认，都由我们念出来，人不说话也念。挂断只关麦，任务接着跑。人不看屏幕。

ElevenLabs 只做耳朵和嘴：采集、识别、断句、打断、把我们送回的字念出来。它不决定派不派活，也不是那只 agent。不用 Realtime。

## 不碰默认的那条 Pi

开新会话、输入框发消息、切会话、重连，都还走现在这条。语音不插进去。

不改 `connect`、`new_session`、`switch_session`，不改 Composer 的发送，不改会话启动参数和系统提示，不挂 `before_agent_start`，不写 `gui-session-profile`，不给普通会话加一套语音人设。旧的 Rime 路径曾经这么做，这次不做。

语音要动那条会话时，只调界面已经在用的命令：`sendPrompt`、`deliveryFor`、`answerDialog`，以及对绑定连接的 `{ type: "abort" }`。叫法和正文跟人在输入框里发出去的一样。会话自己不知道这句话来自麦克风。

```
麦 ──WebRTC──► ElevenLabs（STT + 断句 + 打断 + TTS）
                    │ user_transcript
                    ▼
         tools/speech-engine（管子，不养 Pi）
                    │ http://127.0.0.1:3001/desk
                    ▼
         桌面应用（Jev 一条分类，然后只走一条）
            speak     → 没有工具的嘴，当场答
            dispatch  → 原话一条，发给绑定的桌面会话，先说「开始了」
            watch     → 读这条会话的投影，念，不发消息
            confirm   → 只回答已经播报过的确认
            control   → 别念了 / 挂断 / 停掉
                    │
    orbit-turn-settled / orbit-session-needs-input（绑定的那条）
                    ▼
         播报：通话还在就 sendUserMessage；人已经挂了就本地 TTS
```

## 为什么不是现在这套，也不是 Realtime

现在的 `tools/speech-engine` 接通就 `spawn pi --mode rpc --no-session`。这只不在会话列表里，看不见桌面上正在用的那条，挂断即毁。`sendResponse` 只能在 `onTranscript` 里调用，任务过一会儿做完，它没有开口的权利。所以人还是得看屏幕。

Realtime 更快，但脑子是他们的模型。Pi 只能做成它自己决定要不要调的工具，做完也不会叫人。Jev 插不进开口之前。`seng_…` 也挂不上 Realtime 模型。

Rime 当时好用，是因为它只做耳朵和嘴。派发、旁观、做完了再念，都在这边，而且念的是桌面上那条真会话。这次把 Rime 换成 ElevenLabs，职责划分按那个恢复。断句、回声、PCM 不再自己做。

## 职责

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| 通话 | `src/features/voice` | 球、字幕、开麦/静音/挂断。持有 WebRTC。播报时调用 `sendUserMessage` |
| 桌子 | `src/features/voice/model/` | 绑定焦点、问 Jev、派发、旁观、播报队列。**只有这里能碰桌面会话** |
| 嘴 | 桌子旁边的一只没有工具的生成 | 闲聊、进度的说法、结果摘要。不写会话，不声称自己干过活 |
| 管子 | `tools/speech-engine` | 接 ElevenLabs 的 WS，把转写交给桌子，把桌子的字流式送回。不 spawn Pi |
| 凭据 | `src-tauri/src/elevenlabs.rs` | 不变：key 在 `auth.json`，engine id 在 `eleven.json`，页面只拿短期 token |
| 本地嘴 | 同上，挂断之后 | 通话已断时，用同一把 key、同一个 voice、`eleven_flash_v2_5` 把播报念出来 |

Jev 从 `tools/speech-engine/src/gate.ts` 搬到桌子。管子不再需要 `TYPESAFE_API_KEY`。

## 绑定

开麦时记下当时的 `{ connectionId, sessionFile, cwd }`。这一通就盯这一条。

- 中途人在界面上换了会话，不跟着换。否则一句话会派进另一条。
- 开麦时没有活着的桌面会话：不派活，念「没有正在用的会话」。不偷偷 `new_session`，也不再拉一只 `--no-session`。
- 换焦点是以后的一句明确指令，这一刀不做。

## 管子

ElevenLabs 的协议不变：`onTranscript` 里必须 `sendResponse`，外面调会被丢掉。所以管子只做三件事。

1. 转写以 `orbit:announce:` 开头：不叫桌子，不叫 Jev，把冒号后面的句子原样送回。这是播报，不是用户说的话。
2. 其他转写：转给 `ws://127.0.0.1:3001/desk`，把桌子流回来的字送回 ElevenLabs。
3. 桌子没接上：送回「桌面没接上，这句不会派活。」不编一句回答，不派活。

空转写、纯背景音，沿用现在的丢弃，不送给桌子。

`/health`、隧道、`up.sh`、内存哨兵留着。删掉工人 Pi：`take`、`agents`、`mouths` 里那只带工具的、`--mode rpc --no-session`。闲聊的嘴也不放在管子里，免得又养出第二只看不见桌面的 Pi。

## 播报

这是可以不看屏幕的原因。`sendResponse` 补不了这个洞，所以播报不走那条迟到的调用。

只盯绑定的那条连接：

- `orbit-turn-settled`：这一轮停了。`aborted` 念「停了」。`error` 念失败，不念堆栈。否则拿最后一条助手回复，让嘴收成一两句，不念代码、日志、清单。
- `orbit-session-needs-input`：有一个 `confirm` / `input` / `select` 等着人。念那个问题，并记下 `request.id`。没有这个记录，「可以」不是确认。

通话还开着：页面 `conversation.sendUserMessage("orbit:announce:" + 句子)`。ElevenLabs 把它当成一次用户输入送进管子，管子原样念。这样仍然是一张嘴，回声消除还在他们那边。字幕里不要把这条显示成用户说的话。下一句真用户转写里如果夹着它，桌子在问 Jev 之前剥掉。

这一步要先探针证实：Speech Engine 的服务端协议写明的入站只有 `user_transcript`。客户端有 `sendUserMessage`，但是不是会变成管子的 `onTranscript`，文档没保证。探针不过，通话中的播报改成本地 TTS，播的时候关麦，播完再开。不要两张嘴同时出声。

人已经挂了：仍要念。走本地 TTS，不依赖这通 WebRTC。挂断取消的是麦，不是播报队列。

`contextual_update` 不能用。官方写明它不打断、不念。

## 派发和确认

派发用现成的 `sendPrompt` / `deliveryFor`，不另写一套队列。

- 会话空闲：`{ type: "prompt", message: 用户原话 }`。
- 会话在跑，这句是在改当前任务：`streamingBehavior: "steer"`。`deliveryFor` 发现其实没在跑，会退化成 prompt，桌子按它实际走的那条念。
- 会话在跑，这句是下一件：`streamingBehavior: "followUp"`，念「排上了」。
- 问不到 pi 在不在跑：按 `deliveryBehavior` 现有的规则，当成在跑。不要猜。

消息正文只有用户原话。不包系统提示，不写 `voice_session`，不要求这条桌面会话改成口语。长答案留在会话里；念出来的是嘴的摘要。

确认用 `answerDialog(request, answer, connectionId)`。只对已经播报过的那个 `request.id`。取消是 `{ cancelled: true }`，同意是 `{ confirmed: true }`，其余把原话放进 `{ value }`。

「停掉」是对绑定连接发 `{ type: "abort" }`。不用 `stop()`：那个会清队列再把 steering 重放回去，语音里的停不是这个意思。

## 失败

| 看到的 | 原因 | 说什么 |
| --- | --- | --- |
| 开麦就失败 | `:3001` 没人，或 engine id 和健康检查不一致 | 现在这句，不变 |
| 接通了但每句都说桌面没接上 | 管子在，桌子的 `/desk` 没有 | 这句话，不派活 |
| 说了「开始了」之后一直安静 | 播报探针没过，或本地 TTS 没接 | 不能当成做完了。设置里要能看见上一次播报是走了 `sendUserMessage` 还是本地 TTS |
| 挂断后没有声音 | 播报队列被挂断清掉 | 这是缺陷。挂断只关麦 |

## 明确不做

- Realtime，以及「Realtime 闲聊、Jev 再把某一句拨给 Pi」。
- 短语表。分类只来自 Jev 的一次回答；代码只卡阈值。
- 把闲聊送进桌面会话。
- 开麦时新建会话、或再养一只通话专属 Pi。也不改默认开会话、普通对话那条 Pi。
- 语音里切换到另一条会话。下一刀再做，做的时候也是明确指令，不跟随界面焦点。
- 主动把进度一段段念出来。这一刀只念结束、失败、和需要人回答的确认。人要进度，走 watch。

## 验证

- 管子不再 spawn `pi`。一通电话的进程列表里没有它拉起来的工人。
- 「你好」之后，绑定会话的消息数不变。
- 「把登录改成失败三次锁定」之后，绑定会话多一条，正文等于这句原话。界面先听到「开始了」，麦可以继续说。
- 这轮跑完、人没再说话：念一两句结果。挂断后跑完：仍念。
- 「做到哪了」不增加会话消息。
- 没有待确认时说「可以」，不调用 `answerDialog`。
- 「别念了」只停声音。「停掉」才 `abort`，而且不重放队列。
- 没开麦时，新会话和输入框发消息走的仍是原来的 Pi。会话启动、系统提示、Composer 发送路径没有为语音加分支。
