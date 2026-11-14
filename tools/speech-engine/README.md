# Speech Engine（语音通话的 Pi 服务端）

语音通话里，**声音全部归 ElevenLabs**：麦克风采集、语音识别、轮次判断、打断、语音合成都在他们那边。
这个目录只是一根管子。它不 spawn Pi。桌面应用连上 `http://127.0.0.1:3001/desk`，决定派不派给正在用的那条会话，再把要念的字送回来。

```
浏览器 ──WebRTC──► ElevenLabs（STT + 断句 + 打断 + TTS）
                        │  WebSocket（一通电话一条连接）
                        ▼
            tools/speech-engine（本机常驻，不养 Pi）
                        │  /desk
                        ▼
              桌面应用（Jev、派发、播报）
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
| `PI_ARGS` | 不再使用。管子不启动 Pi |
| `PI_SYSTEM_PROMPT` | 替换默认的口语系统提示 |
| `FILLER` / `FILLER_AFTER_MS` | Pi 迟于这个时间没出字时先说的一句，默认 700ms |
| `SPEECH_LANGUAGE` | 可选。不设就不锁语言，通话跟用户说的语言走 |
| `SPEECH_TTS_MODEL` | 合成模型，默认 `eleven_flash_v2_5` |
| `SPEECH_MAX_SECONDS` | 单通最长秒数，默认 3600，官方上限 7200 |
| `PORT` / `WS_PATH` | 监听地址，默认 `3001` `/ws` |
| `MEMORY_LIMIT_MB` | 内存哨兵，超过就自己退出等重启，默认 4096 |

Eleven Realtime v1 Mini/Max 不能接 Speech Engine，也不能接 Pi。低延迟靠 WebRTC、
`scribe_realtime`、flash 合成和 eager 抢话。重跑 `./up.sh` 会把这些写回已有 Engine。

每句转写交给桌面的 `/desk`。Jev、派发和播报都在应用里。这个进程不读 Jev 的密钥，也不启动 Pi。

## 已知边界

- `sendResponse` 仍然只能在 `onTranscript` 里调用。做完了要开口时，应用用 `sendUserMessage` 把 `orbit:announce:` 送回来，由这里原样念。人已经挂断时，应用自己合成，不经过这里。
- 桌子没接上时，这句只回「桌面没接上，这句不会派活。」
- 免费计划约 1 万字符/月，通话按分钟消耗；额度耗尽会在句子中间断掉。
