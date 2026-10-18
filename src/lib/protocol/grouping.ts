import type { DisplayMessage, DisplayMessageGroup, TurnClock } from './types'

/** 排队中尚未被 pi 确认的乐观预览（见 `reduceEvent` 的 `queued_preview`）。 */
export const isQueuedPreview = (item: DisplayMessage) => item.id.startsWith('queued-')
/**
 * 与上一次分组结果对齐：内容（id + 每条消息引用）完全一致的 group 直接复用旧对象。
 * 流式时每个 tick 只有最后一组真的变了，其余历史组复用后，下游 memo 的
 * `items` 引用比较一步命中，不必再逐条比对。纯引用复用，不改变分组结果。
 */
export function reuseGroups<G extends DisplayMessageGroup>(previous: readonly G[], next: G[]): G[] {
  if (previous.length === 0) return next
  const byId = new Map(previous.map(group => [group.id, group] as const))
  return next.map(group => {
    const old = byId.get(group.id)
    if (!old || old.items.length !== group.items.length) return group
    for (let i = 0; i < group.items.length; i++) if (old.items[i] !== group.items[i]) return group
    return old
  })
}
export function groupDisplayMessages(messages: DisplayMessage[]): DisplayMessageGroup[] {
  // `custom` is an extension-injected message (a sub-agent result). It belongs
  // to the assistant run that is currently in flight, not to a turn of its own:
  // on its own it would be projected as that turn's final answer and rendered at
  // full size in the body, which is exactly where a worker's report does not
  // belong. Kept in the run it is ordinary work prose, so it folds with the rest.
  const inRun = (role: string) => role === 'assistant' || role === 'custom'
  return messages.reduce<DisplayMessageGroup[]>((groups, item, index) => {
    const previous = groups.at(-1)
    if (inRun(item.message.role) && previous?.items.every(entry => inRun(entry.message.role))) {
      previous.items.push(item)
      previous.indexes.push(index)
      return groups
    }
    groups.push({ id: item.id, items: [item], indexes: [index] })
    return groups
  }, [])
}

/**
 * 一个可见的轮（`groupDisplayMessages` 那一组）是从哪条 assistant 开始计时的。
 *
 * 一组里可能有**多次** agent 运行：worker 的结果是 `custom` 消息，会被并进同一组
 * （见 `groupDisplayMessages`），所以从末尾往回走，跳过 assistant / custom，停在
 * 最后一条用户消息之后，取那一组的首条 assistant 作为整组的起跑线。
 */
export function visibleTurnStart(messages: DisplayMessage[]): DisplayMessage | undefined {
  let start = messages.length
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index]
    const role = item.message.role
    // 排队中的乐观预览（user 角色）是下一轮的事，不是这一轮的分界线：它还没被 pi 确认。
    if (role !== 'assistant' && role !== 'custom' && !isQueuedPreview(item)) break
    start = index
  }
  return messages.slice(start).find(item => item.message.role === 'assistant' && item.startedAt !== undefined)
}
/**
 * steer / follow-up 会把一轮拆成共享同一个 startedAt 的多段。一次 turn 只在**最上面**
 * 那段计时：运行时显示「正在处理 Xs」，结束后显示「用时 Xs」；下面被 steer 拆出来的段
 * 只返回 ``hidden``，无论是否正在流式输出都不再重复「正在处理」，避免一轮里两个闪烁的
 * 处理面板。
 */
export function assignTurnClocks(
  groups: readonly { startedAt?: number }[],
  turn: { running: boolean; turnStartedAt: number | null },
): TurnClock[] {
  const runningTurn = turn.running ? turn.turnStartedAt : null
  const seenTurns = new Set<number>()
  return groups.map(group => {
    if (group.startedAt === undefined) return undefined
    if (seenTurns.has(group.startedAt)) return 'hidden'
    seenTurns.add(group.startedAt)
    return runningTurn !== null && group.startedAt === runningTurn ? 'live' : undefined
  })
}
