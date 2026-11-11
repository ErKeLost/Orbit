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
./up.sh        # 一条命令：隧道 → 把 wss 地址写回已有 Engine → 起服务
```

`up.sh` 从 `~/.pi/agent/auth.json` 取密钥，起一条 quick tunnel，然后**原地改**已有
Engine 的 `ws_url`（`src/repoint.ts`），所以重跑一次不会换 `seng_…`，应用里的设置
不用动。第一次跑（`eleven.json` 里还没有 id）才新建 Engine。

手工分步也行：`cloudflared tunnel --url http://localhost:3001` → `PUBLIC_URL=… bun run repoint` →
`SPEECH_ENGINE_ID=… bun run start`。

## 它活着吗

`GET http://127.0.0.1:3001/health` 会回答服务在不在、认哪个 Engine、内存多大、接了几通电话。
应用开麦前先问这个端点：服务没起来就直接说"没在运行"，而不是接通之后一片安静。

隧道 URL 每次重启都会变，变了重跑 `./up.sh` 就好：它 re-point 的是同一个 Engine。
`~/.pi/agent/eleven.json` 里记着 `engineId` 和当前的 `wsUrl`。

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
| `MEMORY_LIMIT_MB` | 内存哨兵，超过就自己退出等重启，默认 4096 |

## 已知边界

- `sendResponse` **只能在 `onTranscript` 里调用**（官方协议如此）。所以“任务完成后主动播报”这条
  路在产品里不存在：用户问了才会说。
- 一通电话一个 Pi 进程，所以它能操作的是**自己这条会话**；要跨会话旁观/steer，需要再桥进
  桌面应用的 RPC，那是另一件事。
- 免费计划约 1 万字符/月，通话按分钟消耗；额度耗尽会在句子中间断掉。
