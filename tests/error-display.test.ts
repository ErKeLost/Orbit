import { describe, expect, test } from 'bun:test'
import { emptyTranscript, formatTranscriptError, normalizeMessage, reduceEvent } from '../src/lib/protocol'

describe('Pi error projection', () => {
  test('keeps provider errors visible in transcript state', () => {
    const state = reduceEvent(emptyTranscript(), {
      type: 'message_end',
      message: { role: 'assistant', content: [], errorMessage: 'provider rejected image input' },
    })
    expect(state.error).toBe('provider rejected image input')
  })

  test('shows the provider error message instead of raw JSON', () => {
    expect(formatTranscriptError('403 {"type":"error","error":{"type":"permission_error","message":"Request not allowed"}}')).toBe('Request not allowed')
  })

  test('falls back to a short label when JSON has no message', () => {
    expect(formatTranscriptError('403 {"type":"error","error":{"type":"permission_error"}}')).toBe('403 · permission_error')
  })

  test('keeps plain session errors readable', () => {
    expect(formatTranscriptError('provider rejected image input')).toBe('provider rejected image input')
  })

  test('hides the previous turn error as soon as a new prompt is submitted', () => {
    const failed = reduceEvent(emptyTranscript(), {
      type: 'message_start',
      message: { role: 'assistant', content: [] },
    })
    const ended = reduceEvent(failed, {
      type: 'message_end',
      message: { role: 'assistant', content: [], errorMessage: 'old provider error' },
    })
    const next = reduceEvent(ended, { type: 'prompt_submitted' })

    expect(next.error).toBeNull()
    expect(next.messages[0].message.errorMessage).toBeUndefined()
  })

  test('手动暂停不产生错误：aborted 消息的错误文本被剥掉，transcript.error 也不置位', () => {
    const started = reduceEvent(emptyTranscript(), {
      type: 'message_start',
      message: { role: 'assistant', content: [{ type: 'text', text: '写到一半' }] },
    })
    const stopped = reduceEvent(started, {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: '写到一半' }], stopReason: 'aborted', errorMessage: 'This operation was aborted' },
    })

    expect(stopped.error).toBeNull()
    expect(stopped.messages[0].message.errorMessage).toBeUndefined()
  })

  test('停止后重开会话（hydrate）同样看不到 abort 错误文本', () => {
    const messages = normalizeMessage({
      role: 'assistant',
      content: [{ type: 'text', text: '写到一半' }],
      stopReason: 'aborted',
      errorMessage: 'This operation was aborted',
    })

    expect(messages.errorMessage).toBeUndefined()
  })

  test('真实 provider 错误不受影响，仍然置位 transcript.error', () => {
    const state = reduceEvent(emptyTranscript(), {
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'provider rejected image input' },
    })

    expect(state.error).toBe('provider rejected image input')
  })
})
