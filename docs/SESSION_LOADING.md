# 会话加载

切换会话看起来是一件事，实际上是四条路径，代价差两个数量级。这里记录每条路径
现在做什么、为什么，以及边界在哪。

## 一条会话的历史是怎么到屏幕上的

```
会话 JSONL ──history::project──▶ Rust ──(图片只留 {session, at, ordinal})──▶ WebView
     ▲                              │                                          │
     │                              └─ 对账：count == get_state.messageCount ──┘
     │                                          │
     │                                          └─ 不一致 → get_messages（权威兜底）
     └─ pi 执行 prompt 时才需要加载它（0.9s / 169MB，在后台）
```

会话文件就是这条会话的全部内容，pi 在每条消息落地时把它追加写入。所以“显示历史”
不需要 pi：Rust 直接读文件、复现 pi 的投影规则（`buildSessionPath` /
`buildContextEntries` / `sessionEntryToContextMessages`），pi 只在真正执行 prompt
时才有用。

## 四条路径

| 场景 | 现在怎么走 | 实测（169 MB 会话） |
|---|---|---|
| 切回一个**还活着**的标签页 | `activateConnection`，不碰 pi、不读盘 | 即时 |
| 切回**本进程读过、文件没变**的会话 | 文件戳 + 条数都对得上，直接用缓存 | 一次 stat |
| 打开/切到**没读过的**会话 | Rust 读 JSONL 投影 → 画出来 → pi 的 `messageCount` 对账 | 首帧 **~110ms** |
| 手机 | Host 的 `session.list` / `get_messages`，图片仍是 base64 | 受 48 MB 帧上限限制 |

实测数据（169 MB / 1049 条消息的会话，release）：

```
history::project（读 JSONL + 投影 + 图片换引用）   111ms     ← 首帧
pi 加载会话（get_state）                          0.9s      ← 后台，不挡首帧
pi 序列化历史（get_messages）                     1.09s / 168.8 MB  ← 只在兜底时发生
 9.7 MB 会话：project 5ms，get_messages 74ms
Rust serde 解析 168.8 MB：41ms；再序列化：88ms
WebView（JSC）JSON.parse 168.8 MB：64ms；hydrate 2ms；分组 1ms
```

## 三个机制

### 1. Rust 投影 + 条数对账（`history::project`）

`session_project(sessionPath)` 返回 `{messages, count, exact, leaf}`：

- 先只解析每条记录的 `id/parentId/type/timestamp`（`serde` 跳过 `message.content`
  不分配，169 MB 的文件也是毫秒级），从 leaf 沿 `parentId` 走出一条路径；
- 只把路径上的记录整条解析出来，按 pi 的规则映射成消息；
- 图片的 base64 换成 `{session, at(行字节偏移), ordinal}`；
- 路径上出现 `compaction` / `branch_summary` / `context_edit` 时 `exact=false`
  ——这三种会改写历史，这个模块不复制它们。

调用方只在 **`exact && count === get_state.messageCount`** 时采用；任何一个不成立
就退回 `get_messages`。所以投影写错只会损失速度，不会损失消息：会话树导航后 pi 的
leaf 只在内存里（文件末尾是废弃分支），条数对不上，自然走兜底。

### 2. 图片按行偏移引用（`session_image`）

投影不复制图片：`{session, at, ordinal}` 指向会话文件里的那一行。渲染时
`useImageSrc` 只对**屏幕上真正出现的图**调 `session_image`，拿到 base64 后缓存成
`data:` URL（JS 侧 LRU 120 条）。169 MB 的会话里 166.5 MB 是图片，WebView 从不
一次性持有它们；磁盘上也不再复制一份 124 MB 的缓存（旧的 `media::offload_history`
只剩在 `get_messages` 兜底路径上使用）。

### 3. 预取与缓存

- 内存缓存最多 6 份 transcript，记 `size:mtime` 文件戳和条数；正在跑（`dirty`）
  的条目不会被任何预取覆盖。
- 会话行 `pointerenter` 时 `primeProjection`：读文件、写缓存。点开就是缓存命中。
- 打开会话时 `startConnection` 在 `pi_connect` **之前**就开始读文件并画出来，所以
  首帧不依赖 pi 的加载速度。
- 一轮结束（`agent_settled`，pi 已落盘）时重新取文件戳、按“messages + tools”
  重算条数，缓存重新可复用。

## 多会话同时跑

所有状态都以会话文件为键，没有任何“当前会话”的全局变量：

- 每条连接自己 `get_state` 对账自己的 `sessionFile` / `messageCount`；
- 投影、图片、缓存都是按路径的纯函数（图片引用里自带 `session`，不会串台）；
- 预取只写干净条目，运行中的会话（`dirty`）不会被覆盖；
- Rust 侧只共享两个只读缓存（列表扫描、轮次耗时），都是 `(path, size, mtime)`
  键控、带互斥锁，命中即返回。

## 边界

- **压缩/分支会话**：`exact=false`，走 pi 的 `get_messages`（首帧要等 pi，169 MB
  会话约 2s）。这三种记录会重写历史，复制它们的规则才是真正的风险，所以选择不复制。
- **手机**：仍然通过 Host 的 `get_messages` 拿历史（图片内联），超大响应会撞
  relay 的 48 MB 上限。下一步是把手机切到 `session_project` + 单张
  `session_image`。
- **不做分页**：首帧是完整投影，不是“加载到某一段”。成本在字节上，图片抽走以后
  一整段历史只有几 MB，分页只会多一套状态，换不来可见收益。
- 缓存只在内存里：进程重启后第一次打开会话要读一次文件（110ms 级），不值得再为
  它加一层磁盘缓存。
