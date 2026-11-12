# 语音通话（ElevenLabs Speech Engine）

实现日期：2026-11-11。替换掉原先自建的 Rime 语音环。

## 一句话

声音链路**不在这个仓库里**。ElevenLabs 负责麦克风采集、语音识别、轮次判断、打断与合成；
桌面应用只负责拿到一枚短期 WebRTC token 并显示通话界面；Pi 那一端在 `tools/speech-engine`。

```
桌面 WebView ──WebRTC──► ElevenLabs（STT + 断句 + 打断 + TTS）
                              │ WebSocket（一通电话一条）
                              ▼
                   tools/speech-engine（本机常驻）
                              │ JSONL / spawn
                              ▼
                    pi --mode rpc（每通电话一个会话）
```

## 职责划分

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| 通话界面 | `src/features/voice/ui/VoicePage.tsx` | 球、对话列表、开始/打断/结束/静音 |
| 通话状态 | `src/features/voice/model/call.ts` | 拿 token、起会话、把 SDK 回调摊平成状态 |
| 凭据与 token | `src-tauri/src/elevenlabs.rs` | API Key 存 `auth.json`（provider `elevenlabs`），engine id 存 `eleven.json`，签发 WebRTC token |
| Pi 服务端 | `tools/speech-engine` | 接受 ElevenLabs 的 WS，把转写交给一个独立 Pi 进程，流式送回回答 |

## 为什么这么切

- 断句、重采样、PCM 排程、分片合并、AEC 这些是“语音工程”，不是这个产品要做的事；
  自建版本的这些代码全部删除（约 2000 行）。
- API Key 不出后端：前端只拿**短期 token**，与其它凭据同一处存放。
- 每通电话一个 `pi --mode rpc` 进程：历史与任务状态天然隔离，挂断即销毁。

## 分岔

转写进来之后、叫醒干活的 Pi 之前，Jev 只回答一个是非题：这句话要不要工作 agent。概率不到 0.75，或者 Jev 没答上来，就不派活。

不派活的那句交给另一个没有工具的 Pi，按用户当时的语言现答。不查短语表，不锁语言。干活的 Pi 只有被选中才收到这句话。

Jev 看到的只有这一句和上一句已经念出来的话。实现在 `tools/speech-engine/src/turn.ts` 和 `gate.ts`。

## 为什么不是 Realtime 模型

Eleven Realtime v1 Mini / Max 是最低延迟的语音模式，但官方限制写明：Speech Engine
和任何自定义 LLM 都不能用 Realtime 模型。Pi 是自己的进程，所以能接到 Pi 的最快路径是
Speech Engine 的低延迟配置，不是把 Voice mode 拨到 Realtime。

`up.sh` 重跑时会写上：`scribe_realtime`、`eleven_flash_v2_5`、`turnEagerness: eager`、
通话上限默认 3600 秒、必须持有 WebRTC token。`speculativeTurn` 不开：它会在句子还没
说完时启动一轮带工具的 Pi。插话是 abort 当前回合再发新 prompt，不用 Pi 的 `steer`
（steer 会等当前工具调用跑完）。没有默认垫句；要先开口，自己设 `FILLER`。

## 明确的限制

- **没有主动播报**。`sendResponse` 只能在 `onTranscript` 里调用，所以 Pi 在用户不再说话之后无法开口。
- **只能操作自己那条会话**。每通电话一个 `pi --mode rpc --no-session`，不写进桌面会话列表。
- 服务端必须公网可达（开发期用 cloudflared）。隧道地址变了就重跑 `tools/speech-engine/up.sh`，不换 `seng_…`。
- 免费计划约 1 万字符/月，通话按分钟消耗积分。

## 失败会长什么样

一通电话有三段：本页 ↔ ElevenLabs ↔ 本机 3001。第三段断掉时，前两段照样接通，
页面就一直"在听"而对面不出声——这也是 2026-11-11 那次"根本不好使"的主因：内核日志里写着
`low swap: killing largest compressed process with pid … (bun) … 49054 MB`，服务端涨到 49 GB
被系统杀掉，隧道于是回 502，而应用里没有任何地方说这件事。

所以现在：

- 服务端和 `/ws` 同端口提供 `GET /health`（engineId、内存、通话数、运行时长）；
- 开麦前先问它，服务没在跑就直说"没在运行，跑一次 up.sh"，而不是让人对着空气说话；
- 设置 → 语音 → 本机服务 也显示同一份状态；
- 服务端有内存哨兵（默认 4 GB 自杀等重启），并接住了 `pi` 子进程的 spawn 错误——那条
  未捕获异常原本会直接把整个服务端带走。

## 配置

`~/.pi/agent/eleven.json`：`{"engineId": "seng_…"}`。
`~/.pi/agent/auth.json` 的 `elevenlabs` 条目：`{"key": "sk_…", "type": "api_key"}`。
两边都能在「设置 → 语音」里改。

## 验证

- `GET /v1/user/subscription` → 计划与剩余额度（设置页「检查」按钮）。
- `GET /v1/convai/conversation/token?agent_id=seng_…` → 200 且返回 `token`，说明 engine 与凭据都有效。
- `GET http://127.0.0.1:3001/health` → 本机服务在不在。
- 端到端：用 `tools/speech-engine/probe.mjs` 拿一个自签的 Speech Engine JWT 连 `wss://…/ws`，
  发一条 `user_transcript`，能在几秒内收到 `agent_response` 就说明整条链路是通的（本机、隧道都试一遍）。
