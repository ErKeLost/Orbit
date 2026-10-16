import { describe, expect, test } from 'bun:test'
import {
  PROMPT_SUGGESTION_STATUS,
  acceptSuggestion,
  claimTurnSuggestion,
  loadPromptSuggestion,
  parseSuggestion,
  savePromptSuggestion,
  shouldAskNextStep,
  suggestionFor,
  transcriptTurn,
} from '../src/features/chat/promptSuggestion'

describe('prompt suggestion payloads', () => {
  test('reads the draft echo, the turn and the text', () => {
    expect(parseSuggestion(JSON.stringify({ draft: '帮我把', turn: '3:1', text: '这个函数拆开' }))).toEqual({ draft: '帮我把', turn: '3:1', text: '这个函数拆开' })
    expect(parseSuggestion(JSON.stringify({ draft: '帮我把', text: '这个函数拆开' }))).toEqual({ draft: '帮我把', text: '这个函数拆开' })
  })

  test('treats malformed and incomplete status as no answer', () => {
    expect(parseSuggestion(null)).toBeNull()
    expect(parseSuggestion('')).toBeNull()
    expect(parseSuggestion('not json')).toBeNull()
    expect(parseSuggestion(JSON.stringify({ draft: 'a' }))).toBeNull()
  })
})

describe('ghost text selection', () => {
  test('only uses a reply for the exact draft it was asked about', () => {
    const reply = { draft: '帮我把', text: '这个函数拆开' }
    expect(suggestionFor(reply, '帮我把', true, '1:a')).toBe('这个函数拆开')
    expect(suggestionFor(reply, '帮我把这', true, '1:a')).toBeNull()
    expect(suggestionFor(reply, '', true, '1:a')).toBeNull()
  })

  test('never paints a continuation when the caret is not at the end', () => {
    const reply = { draft: 'fix the', text: 'race in the loader' }
    expect(suggestionFor(reply, 'fix the', false, '1:a')).toBeNull()
  })

  test('a "what next" guess only belongs to the turn it was made after', () => {
    const guess = { draft: '', turn: '4:1700000000000', text: '把测试补上。' }
    expect(suggestionFor(guess, '', true, '4:1700000000000')).toBe('把测试补上。')
    // 用户已经发出（或收到）了新消息：上一轮的猜测必须自己消失。
    expect(suggestionFor(guess, '', true, '5:1700000001000')).toBeNull()
    // 一旦开始打字，空草稿的那份猜测就不再匹配了。
    expect(suggestionFor(guess, '把', true, '4:1700000000000')).toBeNull()
  })

  test('strips a long restatement of the draft, keeps short shared starts', () => {
    expect(suggestionFor({ draft: '帮我把这个函数重构成', text: '帮我把这个函数重构成异步的' }, '帮我把这个函数重构成', true, '1:a')).toBe('异步的')
    // 两个字的重合更可能是真正的续写（它 → 它们），不能当重复删掉。
    expect(suggestionFor({ draft: '它', text: '它们都会失败' }, '它', true, '1:a')).toBe('它们都会失败')
  })

  test('collapses whitespace and refuses empty or over-long answers', () => {
    expect(suggestionFor({ draft: 'run the', text: '  loader   tests  ' }, 'run the', true, '1:a')).toBe('loader tests')
    expect(suggestionFor({ draft: 'run the', text: '   ' }, 'run the', true, '1:a')).toBeNull()
    expect(suggestionFor({ draft: 'run the', text: 'x'.repeat(200) }, 'run the', true, '1:a')).toBeNull()
  })
})

describe('when to ask for a "what next" guess', () => {
  const base = { enabled: true, paletteOpen: false, atEnd: true, draft: '', settleSeq: 1, askedSeq: 0 }

  test('fires once per finished turn and never again for that turn', () => {
    expect(shouldAskNextStep(base)).toBe(true)
    // 问完把 askedSeq 推上去；之后同一轮里任何重渲染都不再问。
    const asked = { ...base, askedSeq: 1 }
    expect(shouldAskNextStep(asked)).toBe(false)
    // 清空草稿、移动光标、开关面板都不算新的一轮。
    expect(shouldAskNextStep({ ...asked, draft: '' })).toBe(false)
    expect(shouldAskNextStep({ ...asked, settleSeq: 1 })).toBe(false)
  })

  test('a new finished turn is one more call, not a repeat of the last one', () => {
    expect(shouldAskNextStep({ ...base, settleSeq: 2, askedSeq: 1 })).toBe(true)
  })

  test('two panes on one session claim a finished turn only once', () => {
    const connection = 'cwd#pane-a'
    expect(claimTurnSuggestion(connection, '5:1700')).toBe(true)
    expect(claimTurnSuggestion(connection, '5:1700')).toBe(false)
    // 下一轮是新的身份，可以再问一次。
    expect(claimTurnSuggestion(connection, '7:1702')).toBe(true)
    // 另一个连接互不影响。
    expect(claimTurnSuggestion('cwd#pane-b', '5:1700')).toBe(true)
  })

  test('a turn that ended before this view existed costs nothing', () => {
    // 打开旧会话、或面板切换回来时 settleSeq 是 0。
    expect(shouldAskNextStep({ ...base, settleSeq: 0, askedSeq: 0 })).toBe(false)
  })

  test('never fires while there is a draft, a palette, or the caret is not at the end', () => {
    expect(shouldAskNextStep({ ...base, draft: '写一半' })).toBe(false)
    expect(shouldAskNextStep({ ...base, draft: '   ' })).toBe(true)
    expect(shouldAskNextStep({ ...base, paletteOpen: true })).toBe(false)
    expect(shouldAskNextStep({ ...base, atEnd: false })).toBe(false)
    expect(shouldAskNextStep({ ...base, enabled: false })).toBe(false)
  })
})

describe('turn identity', () => {
  test('changes when a message lands, so old guesses stop matching', () => {
    const first = transcriptTurn([{ message: { role: 'user', timestamp: 1 } }])
    const second = transcriptTurn([{ message: { role: 'user', timestamp: 1 } }, { message: { role: 'assistant', timestamp: 2 } }])
    expect(first).not.toBe(second)
    expect(transcriptTurn([])).toBe('0')
  })
})

describe('accepting a suggestion', () => {
  test('appends the continuation and puts the caret after it', () => {
    expect(acceptSuggestion('帮我把', true, '这个函数拆开')).toEqual({ text: '帮我把这个函数拆开', caret: 9 })
  })

  test('does nothing without a suggestion or when the caret moved away', () => {
    expect(acceptSuggestion('帮我把', true, null)).toBeNull()
    expect(acceptSuggestion('帮我把', false, '这个函数拆开')).toBeNull()
  })
})

describe('when to ask', () => {
  test('the stored preference round-trips and defaults to on', () => {
    const store = new Map<string, string>()
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    })
    try {
      expect(loadPromptSuggestion()).toBe(true)
      savePromptSuggestion(false)
      expect(loadPromptSuggestion()).toBe(false)
      savePromptSuggestion(true)
      expect(loadPromptSuggestion()).toBe(true)
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original)
    }
  })

  test('the status key stays in sync with the extension command', () => {
    expect(PROMPT_SUGGESTION_STATUS).toBe('gui-suggest')
  })
})
