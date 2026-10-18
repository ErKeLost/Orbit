/**
 * 一条消息该怎么投递：排队进正在跑的那一轮，还是自己开一轮。
 *
 * pi 的 steer / follow-up 只有在一轮真的在跑时才会被消费：回合开始时、以及每次
 * 工具调用之后各取一次队列，取完这一轮就结束。所以排队进去的消息如果没有「一轮在
 * 跑」等着消费它，就会永远留在队列里——界面上就是输入框上方那行「正在引导…」，
 * 消息既没发出去也没退回来。发过图的那条更糟：它可能没有正文，而撤回队列
 * (`clear_queue`) 只回文本，图救不回来。
 *
 * UI 的 `running` 是投影，比 pi 慢一个事件；手机上重连/丢包还会让它更慢。所以真正
 * 投递前要问 pi 一句（`deliveryFor`），这里只负责那一条规则本身。
 */
export type QueueBehavior = 'steer' | 'followUp'

export type Delivery = {
  /** 仍然带 `streamingBehavior` 投递（进队列）。 */
  streamingBehavior?: QueueBehavior
  /** 退化成普通 prompt：pi 其实没在跑，这一轮当场开始。 */
  degraded: boolean
}

/**
 * `streaming` 传 `undefined` 表示问不到 pi（超时、连接抖动）。
 *
 * 问不到时按「在跑」处理：最多是退回排队（和以前一样），而猜「没在跑」会把一条
 * 本该排队的消息变成一次 `Agent is already processing` 失败。
 */
export function deliveryBehavior(behavior: QueueBehavior | undefined, streaming: boolean | undefined): Delivery {
  if (!behavior) return { degraded: false }
  if (streaming === false) return { degraded: true }
  return { streamingBehavior: behavior, degraded: false }
}
