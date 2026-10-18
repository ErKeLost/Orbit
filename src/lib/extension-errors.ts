/**
 * pi 的「这个扩展 ctx 已经不属于任何会话」守卫，以及对它的处理口径。
 *
 * 会话被替换（`ctx.newSession` / `fork` / `switchSession` / `reload`）之后，pi 会
 * 把旧会话的扩展上下文标记作废；任何**在替换之前开始、在替换之后才回来**的扩展
 * 调用（写 status、写会话名、追加条目）都会拿到这句英文。它说的是「这次扩展调用
 * 属于的那条会话已经没了」，不是用户能处理的故障，也不是这一轮的回答出错。
 *
 * 为什么只有手机看得到：桌面端在「正在跑」时换会话是另起一个 pi 进程，旧进程连
 * 同它的扩展一起被扔掉；手机端只有一条常驻 pi 进程（见 `rpc-session.ts` 里
 * `swapsConnection` 对 `mobileRuntime()` 的排除），替换是原地做的，所以这些迟到的
 * 调用会撞在同一个进程里。
 */
const STALE_EXTENSION_CTX = 'extension ctx is stale after session replacement or reload'

/** 出错值里那段文本（Error / 字符串 / 事件上的 `error` 字段都可能）。 */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  if (value && typeof value === 'object') {
    const record = value as { message?: unknown; error?: unknown }
    if (typeof record.message === 'string') return record.message
    if (typeof record.error === 'string') return record.error
  }
  return value === undefined || value === null ? '' : String(value)
}

/** 这次失败是不是「会话已经换掉、旧扩展 ctx 作废」这一类。 */
export function isStaleExtensionContextError(value: unknown): boolean {
  return textOf(value).toLowerCase().includes(STALE_EXTENSION_CTX)
}

/**
 * 需要把这件事讲给用户时的说法。
 *
 * 显示的时机只有一处：用户刚点的动作确实没生效（例如它所属的会话已经被另一台
 * 设备切走）。诊断信息（英文原文）不往界面上放。
 */
export const SESSION_REPLACED_MESSAGE = '会话已切换，这一步跟着旧会话作废了'
