# Speech Engine（语音通话的 Pi 服务端）

语音通话里，**声音全部归 ElevenLabs**：麦克风采集、语音识别、轮次判断、打断、语音合成都在他们那边。
这个目录只负责“大脑那一端”——ElevenLabs 从云端连进来，我们把它收到的转写交给 Pi，再把 Pi 的回答
流式送回去念出来。

```
浏览器 ──WebRTC──► ElevenLabs（STT + 断句 + 打断 + TTS）
                        │  WebSocket（一通电话一条连接）
                        ▼
            tools/speech-engine（本机常驻进程）
                        │  spawn / JSONL
                        ▼
              pi --mode rpc（每通电话一个独立会话）
```

## 跑起来

```bash
cd tools/speech-engine
bun install
cp .env.example .env          # 填 ELEVENLABS_API_KEY / PI_CWD

# 1. 先开隧道（ElevenLabs 只能访问公网 HTTPS）
/tmp/cloudflared tunnel --url http://localhost:3001     # 或 ngrok http 3001

# 2. 用隧道地址创建 Speech Engine（dashboard 没有这个界面）
PUBLIC_URL=https://xxx.trycloudflare.com bun run create-engine
#   → engine: seng_…  填进 .env 的 SPEECH_ENGINE_ID

# 3. 起服务
bun run start
```

隧道 URL 每次重启都会变，变了就要重新 `create-engine`（会生成新的 `seng_…`），再把新的 id 填进
`ELEVENLABS_API_KEY` 那一对设置里（应用内：设置 → 语音 → Speech Engine ID，或直接写
`~/.pi/agent/eleven.json`）。

## 设置项

| 变量 | 作用 |
| --- | --- |
| `ELEVENLABS_API_KEY` | 用于校验来自 ElevenLabs 的连接 |
| `SPEECH_ENGINE_ID` | `seng_…`，必须和 webhook 目标一致 |
| `PI_CWD` | Pi 的工作目录（工具的根） |
| `PI_ARGS` | 传给 Pi 的额外参数，例如 `--model deepseek-flash` |
| `PI_SYSTEM_PROMPT` | 追加到语音会话的系统提示 |
| `FILLER` / `FILLER_AFTER_MS` | Pi 迟于这个时间没出字时，先说一句缓冲话 |
| `PORT` / `WS_PATH` | 监听地址，默认 `3001` `/ws` |

## 已知边界

- `sendResponse` **只能在 `onTranscript` 里调用**（官方协议如此）。所以“任务完成后主动播报”这条
  路在产品里不存在：用户问了才会说。
- 一通电话一个 Pi 进程，所以它能操作的是**自己这条会话**；要跨会话旁观/steer，需要再桥进
  桌面应用的 RPC，那是另一件事。
- 免费计划约 1 万字符/月，通话按分钟消耗；额度耗尽会在句子中间断掉。
