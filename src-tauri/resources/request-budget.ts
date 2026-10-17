/**
 * 请求体预算：发出去之前，把历史里的截图压到服务端肯收的体积以内。
 *
 * 为什么需要它。一个 51MB 的会话（18 张 2048px 截图，base64 合计 46.8MB）在第十九
 * 次提问时被网关拒了 ——
 *
 *     413 Failed to buffer the request body: length limit exceeded
 *
 * 会累加的是**历史**：用户看到的是一张截图，模型收到的是这段对话里的每一张。单张图
 * 有上限（Pi 自己的 `inputLimits.images.resize` 管着），**总量没有**。这个文件补的
 * 就是总量 —— 新的先留，旧的先丢，丢掉的在原地换一行占位文本。
 *
 * 上限是实测来的，不是猜的（api.deepseek.com `/chat/completions`，2026-10）：
 *
 * | 请求体字节数 | 服务端回答 |
 * | --- | --- |
 * | 50 331 630 | 400（模型名错 —— body 已被受理） |
 * | 51 380 206 | 413 Failed to buffer the request body |
 * | 53 477 358 | 413 openresty HTML |
 *
 * 也就是这家网关在 50MB 附近就关门。默认预算 24MiB：留一半余量给工具 schema、
 * provider 包装和估算误差，同时仍然放得下七八张截图。
 *
 * 两条不能破的边界：
 *
 * * **只改这一次请求。** Pi 的 `context` 事件是 request-local 的（handler 返回的消息
 *   只用于本次模型调用，Pi 随后恢复原状），所以会话历史、磁盘上的 session 文件、
 *   界面里的图都原样保留 —— 预算允许时，被略去的图下一轮还会回来。
 * * **最新的一定留。** 用户刚拖进来的图就是这一轮的问题本身：`keepRecentImages`
 *   张之内永远不丢，丢的是更早的。
 */

/** 默认的一次请求体积上限，字节。 */
export const DEFAULT_REQUEST_BUDGET_BYTES = 24 * 1024 * 1024
/** 默认永远保留的最近图片张数：一轮问题里的图不该被自己挤掉。 */
export const DEFAULT_KEEP_RECENT_IMAGES = 2
/**
 * 估算只数了消息，没数 provider 的请求包装和工具 schema（`context` 事件里看不到
 * 它们）。这个预留就是为它们留的，同时吸收 JSON 估算的误差。
 */
export const REQUEST_BUDGET_RESERVE_BYTES = 512 * 1024

const MIN_BUDGET_BYTES = 512 * 1024
const MAX_BUDGET_BYTES = 512 * 1024 * 1024
const MAX_KEEP_RECENT_IMAGES = 32

export type RequestBudgetSettings = {
  /** false 时原样放行，一次都不动。 */
  enabled: boolean
  /** 一次请求的估算体积上限，字节。 */
  maxRequestBytes: number
  /** 无论如何保留最近这几张图片。 */
  keepRecentImages: number
}

/** 只声明这个预算器真正读到的字段，别把一个包的内部类型引进来。 */
export type BudgetBlock = { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown }
export type BudgetMessage = { role?: unknown; content?: unknown }

export type RequestBudgetResult<T extends BudgetMessage> = {
  messages: T[]
  /** 被换成占位文本的图片张数。 */
  dropped: number
  /** 改动前后这一次请求的估算体积，字节。 */
  bytesBefore: number
  bytesAfter: number
  limit: number
  /**
   * 裁完之后仍然超预算。
   *
   * 会这样有两种原因，都是刻意的取舍而不是 bug：非图片部分自己就超了（占位文本也
   * 救不了），或者 `keepRecentImages` 张之内无条件保留的图加起来就超了（最新的一定
   * 留）。两种都必须报出来：预算器的整条价值就是让 413 变成可解释的，而不是把超限
   * 悄悄发出去。
   */
  overLimit: boolean
}

function isImageBlock(block: unknown): block is { type: "image"; data: string; mimeType?: string } {
  if (!block || typeof block !== "object") return false
  const value = block as BudgetBlock
  return value.type === "image" && typeof value.data === "string" && value.data.length > 0
}

function utf8Bytes(text: string): number {
  // 中文在 JSON 里是一个 UTF-16 码元、三个 UTF-8 字节；身体按 UTF-8 发出去。
  return typeof Buffer === "undefined" ? text.length : Buffer.byteLength(text, "utf8")
}

function serializedBytes(value: unknown): number {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? 0 : utf8Bytes(text)
  } catch {
    return 0
  }
}

function finiteBytes(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

/** 和字节数不同，这里的 0 是有意义的值：一张都不保护，历史图片全部按预算走。 */
function finiteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

/**
 * 配置来自三处，优先级从高到低：磁盘上的 `request-budget.json`、模型目录自己声明的
 * `inputLimits.maxRequestBytes`、内置默认值。
 *
 * 模型声明的是「服务端肯收多少」，所以要把预留减掉；默认值已经把预留算进去了。
 */
export function resolveRequestBudgetSettings(stored: unknown, modelLimitBytes?: number): RequestBudgetSettings {
  const raw = stored && typeof stored === "object" ? (stored as Record<string, unknown>) : {}
  const declared = finiteBytes(raw.maxRequestBytes)
  const model = finiteBytes(modelLimitBytes)
  const fromModel = model === undefined ? undefined : Math.max(MIN_BUDGET_BYTES, model - REQUEST_BUDGET_RESERVE_BYTES)
  const budget = declared ?? fromModel ?? DEFAULT_REQUEST_BUDGET_BYTES
  const keep = finiteCount(raw.keepRecentImages)
  return {
    enabled: raw.enabled !== false,
    maxRequestBytes: Math.min(MAX_BUDGET_BYTES, Math.max(MIN_BUDGET_BYTES, budget)),
    keepRecentImages: Math.min(MAX_KEEP_RECENT_IMAGES, keep === undefined ? DEFAULT_KEEP_RECENT_IMAGES : Math.max(0, keep)),
  }
}

/**
 * 这一次请求的估算体积：非图片部分按 UTF-8 序列化算，图片部分直接数 base64 字符
 * （base64 字母表不含需要转义的字符，一个字符就是一个字节）。
 */
export function estimateRequestBytes(messages: readonly BudgetMessage[]): number {
  let images = 0
  const shimmed = messages.map((message) => {
    const content = message.content
    if (!Array.isArray(content)) return message
    let changed = false
    const next = content.map((block) => {
      if (!isImageBlock(block)) return block
      changed = true
      images += block.data.length
      return { ...block, data: "" }
    })
    return changed ? { ...message, content: next } : message
  })
  return serializedBytes(shimmed) + images
}

function placeholder(limit: number, count: number): string {
  const value = limit / 1024 / 1024
  return `[图片已省略：本次请求超出 ${Number.isInteger(value) ? value : value.toFixed(1)}MiB 预算，略去较早的 ${count} 张]`
}

/**
 * 按预算改写这一次请求。
 *
 * 从新到旧走一遍图片：`keepRecentImages` 张之内无条件保留；再往前的，只要「非图片部分
 * + 已保留的图 + 这张图」还在预算内就留，第一张放不下的连同它更早的全部略去 —— 单调的
 * 规则比「尽量塞满」好解释，也不会出现「留了更老的、丢了更新的」。
 *
 * 同一条消息里被略去的图合并成一行占位文本，插在第一张被略去的位置：模型要能看出
 * 这里本来有图，而不是以为对话断了一截。
 */
export function applyRequestBudget<T extends BudgetMessage>(
  messages: readonly T[],
  settings: RequestBudgetSettings,
): RequestBudgetResult<T> {
  const before = estimateRequestBytes(messages)
  const unchanged: RequestBudgetResult<T> = {
    messages: messages as T[],
    dropped: 0,
    bytesBefore: before,
    bytesAfter: before,
    limit: settings.maxRequestBytes,
    overLimit: before > settings.maxRequestBytes,
  }
  if (!settings.enabled) return unchanged

  const images: { message: number; block: number; bytes: number }[] = []
  for (const [message, entry] of messages.entries()) {
    const content = entry.content
    if (!Array.isArray(content)) continue
    for (const [block, item] of content.entries()) {
      if (isImageBlock(item)) images.push({ message, block, bytes: item.data.length })
    }
  }
  if (!images.length) return unchanged

  const nonImageBytes = before - images.reduce((total, image) => total + image.bytes, 0)
  const kept = new Set<string>()
  let total = nonImageBytes
  let floor = 0
  for (const image of [...images].reverse()) {
    const withinFloor = floor < settings.keepRecentImages
    if (!withinFloor && total + image.bytes > settings.maxRequestBytes) break
    kept.add(`${image.message}:${image.block}`)
    total += image.bytes
    floor += 1
  }
  const dropped = images.length - kept.size
  if (dropped === 0) return unchanged

  const droppedByMessage = new Map<number, number>()
  for (const image of images) {
    if (kept.has(`${image.message}:${image.block}`)) continue
    droppedByMessage.set(image.message, (droppedByMessage.get(image.message) ?? 0) + 1)
  }

  const next = messages.map((message, index) => {
    const count = droppedByMessage.get(index)
    if (!count) return message
    const content = message.content as unknown[]
    const keptBlocks: unknown[] = []
    let placed = false
    for (const [position, block] of content.entries()) {
      if (isImageBlock(block) && !kept.has(`${index}:${position}`)) {
        if (!placed) {
          keptBlocks.push({ type: "text", text: placeholder(settings.maxRequestBytes, count) })
          placed = true
        }
        continue
      }
      keptBlocks.push(block)
    }
    return { ...message, content: keptBlocks } as T
  })

  // 量发出去的东西本身，而不是用各部分拼一个预测值：裁剪自己插进去的占位文本也是请求
  // 体的一部分，把它漏掉会让这个数报出一个装得下、实际装不下的请求。
  const bytesAfter = estimateRequestBytes(next)
  return { messages: next, dropped, bytesBefore: before, bytesAfter, limit: settings.maxRequestBytes, overLimit: bytesAfter > settings.maxRequestBytes }
}
