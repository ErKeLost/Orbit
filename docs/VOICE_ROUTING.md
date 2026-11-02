# 语音路由判定表

实现：`src-tauri/resources/voice/router.ts`（判定）、`src/features/voice/model/voice-controller.ts`（执行）、
`src-tauri/resources/voice/execution-context.ts`（发给 Pi 的消息）。

这份表是行为契约。要加场景，先在这里加一行，再加一个用例；不要为新场景增加阈值。

## 一次话语只走一条流水线

| 流水线 | 由谁执行 | 发 Pi 消息 | 典型话语 |
| --- | --- | --- | --- |
| 控制 | `VoiceController`，零模型 | 不发（abort/steer 除外） | 「别念了」「挂了吧」「看另一个会话」 |
| 语音线 | Rime + 对话模型（无工具） | 不发 | 「你好」「谢谢」「嗯」「你在干嘛」 |
| 派发 | Pi（一次一条消息） | 发 1 条 | 「重启采集器」「北京天气」「改成查行情」 |
| 旁观（oncall） | 只读 `TaskView` + 事件订阅 | **不发** | 「做到哪了」「结果呢」「为什么这么改」 |

旁观不产生消息是硬性要求：进度、结果、失败原因都已经在内存投影里，再问 Pi 一遍等于让它
复述自己——慢、污染上下文，还会得到「我再看看」这种假进展。

## 四个问句，命中即停

```
Q0 是在跟"这次通话"说话吗？        → control_voice / control_task / change_focus
Q1 是在回答一个已播报的确认吗？    → reply_confirmation（控制消息，不是新任务）
Q2 指的是"已有的工作"吗？          → query_progress / analyze_session / watch_task（零消息）
Q3 要求一个"要拿到的结果"吗？      → dispatch_task / steer_task / queue_task / lookup（一条消息）
Q4 其余                            → general_question；看起来像请求但没把握 → clarify（问一次）
```

Q2 必须排在 Q3 前面：「现在做到哪了」既有疑问词又指已有工作，顺序一反就变成派发。

## 谁能把工作交给 Pi

- **只有主判断 `effect === "execute"` 可以。** 社交（`respond`）、澄清（`clarify`）、
  缺失 `effect` 都不能，除非是「刚问过你一句」的澄清回答（`pendingRequest` 命中）。
- 派发还必须有正向证据：

| 意图 | 证据 |
| --- | --- |
| `dispatch_task` / `steer_task` / `queue_task` | `actionability ≥ 0.75` |
| `lookup` | `actionability ≥ 0.45` |

- 写操作另有独立门槛（`validatedDecision`）：`dispatch`/`queue` 的 `mutation ≥ 0.7`，
  `steer` 的 `mutation ≥ 0.8` 且 `deliveryConfidence ≥ 0.8`。证据不足时降级成 `clarify`，
  由语音问一句，而不是赌一把。
- `delivery` 缺失或非法不当作 `additional`，直接 `clarify("invalid_decision")`。

## 缺失的判断标准不等于 0

`commonConversationOnly` 以前缺省 `0.5`，低于阈值就派发——模型没返回、返回格式不对、
或者中文短句没给分，都会变成「开一个 agent 回合」。现在：

- 缺失 = `undefined`，不参与判定；
- `mutation`/`actionability` 缺失时按 0 计算（安全方向），只导致更保守的结果；
- 唯一允许的「默认动作」是留在语音线或问一句。

## 派发消息长什么样

```
<用户原话>
```

只在澄清续接时加三行桥接：

```
Original request: …
Voice clarification: …
User clarification: …
```

不再注入任何系统提示式前缀。之前那句
`Answer the user's informational request as Pi, using the current conversation…` 有三个后果：
出现在用户的工作会话里、把「用户在问信息」强加给「Ah.」、并且用
`using the current conversation` 把 Pi 推向会话里的旧问题。

## 去重

派发前用 `(normalized request, kind, sessionFile)` 查 `TaskLedger`：

| 记录状态 | 行为 |
| --- | --- |
| `queued` / `running` / `waiting` | 不发送，说「已经在跑」 |
| `settled` 且是 `lookup` | 直接播报缓存结果，不产生新回合 |
| `settled` 且是 `action` | 允许重新派发（同一句话再说一次是明确意图） |
| 无记录 | 派发一条 |

## 语言边界

STT 只有 en/es，且服务端不自动检测；TTS 也没有中文。中文语音进来时，判定与理解仍可能成立，
但输出会被 `assertSpokenScript` 拦死。这是供应商能力边界，不是路由可以"猜"的地方：
不要把非拉丁转写当成普通请求塞给 Pi。

## 场景表

| 话语 | 状态 | 结果 |
| --- | --- | --- |
| 你好？ / Ah. / 谢谢 | 任意 | 语音线回答 |
| 你在干嘛 | 空闲 | 语音线回答 |
| 现在做到哪了 | 运行中 | 从 TaskView 播报，零消息 |
| 结果呢 | 已 settled | 播报最近回复，零消息 |
| 为什么这么改 | 任意 | 语音模型读 TaskView 解释，零消息 |
| 继续做，完成告诉我 | 运行中 | 只观察，零消息 |
| 重启采集器 | 任意 | 派发一条 |
| 重启采集器（再说一次） | 运行中 | 说「已经在跑」，零消息 |
| 北京现在天气怎么样 | 任意 | lookup 一条 |
| 开始一个任务 | 任意 | 先问要做什么 |
| 别念了 | 任意 | 停播，任务不动 |
| 停掉当前任务 | 任意 | abort，零新任务 |
| 可以（说过的确认） | 等待确认 | 通过 gateway 回答该确认 |

## 测试

- `src/features/voice/model/router-routing.test.ts`：判定表本身（含回归：`你好？` 不再变 lookup）。
- `tests/voice-routing.test.ts`：责任边界、缺失判断标准、确认身份、任务证据。
- `src/features/voice/model/voice-controller.test.ts`：通话状态机、派发、去重、播报隔离。
