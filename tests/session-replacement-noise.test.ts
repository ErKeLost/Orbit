import { describe, expect, test } from 'bun:test'
import { isStaleExtensionContextError } from '../src/lib/extension-errors'
import { deliveryBehavior } from '../src/lib/session-delivery'
import { emptyTranscript, normalizeMessage, reduceEvent } from '../src/lib/protocol'

/**
 * pi 在会话被替换后给旧扩展 ctx 设的守卫。
 *
 * 手机端只有一条常驻 pi 进程，`new_session` / `switch_session` 是原地做的，所以
 * 一个还挂在 await 里的 `/gui-*` 命令回来写 status 时会撞上它。它是「这次扩展调用
 * 属于的会话已经没了」，不是用户能处理的故障：不能画成会话级错误。
 */
const STALE =
  'This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().'

describe('pi 的 stale extension ctx 守卫', () => {
  test('识别 Error、字符串和事件对象上的文本', () => {
    expect(isStaleExtensionContextError(new Error(STALE))).toBe(true)
    expect(isStaleExtensionContextError(STALE)).toBe(true)
    expect(isStaleExtensionContextError({ error: STALE, event: 'command' })).toBe(true)
    expect(isStaleExtensionContextError({ message: STALE })).toBe(true)
    // pi 的原文大小写可能随版本变化
    expect(isStaleExtensionContextError(STALE.toLowerCase())).toBe(true)
  })

  test('不把普通失败当成它', () => {
    expect(isStaleExtensionContextError(new Error('provider rejected image input'))).toBe(false)
    expect(isStaleExtensionContextError('会话已切换')).toBe(false)
    expect(isStaleExtensionContextError(undefined)).toBe(false)
    expect(isStaleExtensionContextError(null)).toBe(false)
  })
})

describe('transcript 不把守卫画成会话错误', () => {
  test('extension_error 事件里的守卫被忽略', () => {
    const state = reduceEvent(emptyTranscript(), { type: 'extension_error', event: 'command', error: STALE })
    expect(state.error).toBeNull()
  })

  test('其它 extension_error 仍然可见', () => {
    const state = reduceEvent(emptyTranscript(), { type: 'extension_error', event: 'command', error: '生成图片失败' })
    expect(state.error).toBe('生成图片失败')
  })

  test('assistant 消息上的守卫被剥掉，provider 错误保留', () => {
    const stale = normalizeMessage({ role: 'assistant', content: [], errorMessage: STALE })
    expect(stale.errorMessage).toBeUndefined()

    const provider = normalizeMessage({ role: 'assistant', content: [], errorMessage: 'context length exceeded' })
    expect(provider.errorMessage).toBe('context length exceeded')
  })

  test('message_end 带着守卫时不会点亮错误条', () => {
    const started = reduceEvent(emptyTranscript(), { type: 'message_start', message: { role: 'assistant', content: [] } })
    const ended = reduceEvent(started, {
      type: 'message_end',
      message: { role: 'assistant', content: [], errorMessage: STALE, stopReason: 'error' },
    })
    expect(ended.error).toBeNull()
  })
})

describe('排队投递只在一轮真的在跑时发生', () => {
  test('没有排队意图时原样投递', () => {
    expect(deliveryBehavior(undefined, false)).toEqual({ degraded: false })
    expect(deliveryBehavior(undefined, true)).toEqual({ degraded: false })
  })

  test('pi 在跑：消息按 steer / follow-up 进队列', () => {
    expect(deliveryBehavior('steer', true)).toEqual({ streamingBehavior: 'steer', degraded: false })
    expect(deliveryBehavior('followUp', true)).toEqual({ streamingBehavior: 'followUp', degraded: false })
  })

  test('pi 没在跑：退化成普通 prompt，自己开一轮（否则队列没人消费）', () => {
    expect(deliveryBehavior('steer', false)).toEqual({ degraded: true })
    expect(deliveryBehavior('followUp', false)).toEqual({ degraded: true })
  })

  test('问不到 pi 时按「在跑」处理：宁可排队，也不要 Already processing', () => {
    expect(deliveryBehavior('steer', undefined)).toEqual({ streamingBehavior: 'steer', degraded: false })
  })
})
