import { describe, expect, test } from 'bun:test'
import { applyGuiToolSelection, parseSessionMetadata, parseSuggestionText, readClassifierImages, suggestionConversation, suggestionFailure, suggestionUserText } from '../src-tauri/resources/gui-extension'
import { enableFastSearchTools, FAST_SEARCH_TOOLS } from '../src-tauri/resources/search-tools'
import { enableWebSearchTool, formatWebSearchResult, resolveWebSearchSettings, webSearchRequest, WEB_SEARCH_TOOL } from '../src-tauri/resources/web-search'

describe('agent-generated session metadata', () => {
  test('accepts compact titles and supported semantic icons', () => {
    expect(parseSessionMetadata('```json\n{"title":"修复启动竞态","icon":"bug"}\n```')).toEqual({title:'修复启动竞态',icon:'bug'})
  })

  test('uses the default icon for an unsupported model choice', () => {
    expect(parseSessionMetadata('{"title":"分析会话","icon":"made-up"}')).toEqual({title:'分析会话',icon:'message-square'})
  })
})

describe('composer prompt suggestion', () => {
  test('reads the <text></text> block the instruction asks for', () => {
    expect(parseSuggestionText('<text>异步的</text>')).toBe('异步的')
    expect(parseSuggestionText('  <text> 拆成  两个函数 </text>\n')).toBe('拆成 两个函数')
    // 空块 = 「这里没什么可续的」。
    expect(parseSuggestionText('<text></text>')).toBeNull()
    expect(parseSuggestionText('<text>   </text>')).toBeNull()
  })

  test('still accepts the shapes models fall back to', () => {
    // 小模型经常不套格式，直接把续写本身丢回来。
    expect(parseSuggestionText('改成异步的')).toBe('改成异步的')
    expect(parseSuggestionText('"改成异步的"')).toBe('改成异步的')
    expect(parseSuggestionText('{"text":"异步的"}')).toBe('异步的')
    // 合法的 JSON 但不是补全回答：不画。
    expect(parseSuggestionText('{"other":1}')).toBeNull()
    // 没有格式时只取第一行，后面的段落是解释。
    expect(parseSuggestionText('改成异步的\n\n这里我把它拆成两个函数。')).toBe('改成异步的')
  })

  test('an empty or over-long answer leaves no ghost text', () => {
    expect(parseSuggestionText('')).toBeNull()
    expect(parseSuggestionText('   ')).toBeNull()
    expect(parseSuggestionText(`<text>${'x'.repeat(200)}</text>`)).toBeNull()
    expect(parseSuggestionText('x'.repeat(200))).toBeNull()
  })

  test('a truncated or failed completion is not a suggestion', () => {
    // pi 的压缩 agent 同款闸门：maxTokens 被挤满时拿到的是半句话，不能画出去。
    expect(suggestionFailure('length', false)).toBe(true)
    expect(suggestionFailure('error', false)).toBe(true)
    expect(suggestionFailure('stop', true)).toBe(true)
    expect(suggestionFailure('stop', false)).toBe(false)
    expect(suggestionFailure(undefined, false)).toBe(false)
  })

  test('the draft is data in a tag and the instructions come last', () => {
    const message = suggestionUserText('帮我把这个函数', '[User]: 重构 loader\n[Assistant]: 好了')
    expect(message.startsWith('<conversation>\n[User]: 重构 loader\n[Assistant]: 好了\n</conversation>\n\n# Instructions')).toBe(true)
    expect(message).toContain('<draft>\n帮我把这个函数\n</draft>')
    expect(message).toContain('<text></text>')
    expect(message).not.toContain('Current draft')
  })

  test('an empty draft switches to guessing the next sentence', () => {
    const message = suggestionUserText('', '[User]: 请问仓库是做什么的\n[Assistant]: 我还没读过文件')
    expect(message.startsWith('<conversation>')).toBe(true)
    expect(message).toContain('Predict what the user will type next')
    expect(message).not.toContain('<draft>')
    expect(suggestionUserText('   ', '')).toContain('# Instructions')
  })

  test('serializes the conversation the way pi serializes one for summarization', () => {
    const ctx = {
      sessionManager: {
        getEntries: () => [
          { type: 'message', message: { role: 'user', content: [{ type: 'text', text: '把 loader 改成异步' }] } },
          {
            type: 'message',
            message: {
              role: 'assistant',
              content: [
                { type: 'thinking', thinking: '先看实现' },
                { type: 'text', text: '先看一下  现有实现' },
                { type: 'toolCall', name: 'read', arguments: { path: 'src/loader.ts' } },
                { type: 'toolCall', name: 'read', arguments: { path: 'src/index.ts' } },
              ],
            },
          },
          { type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'export function load() {}' }] } },
          { type: 'message', message: { role: 'toolResult', isError: true, content: [{ type: 'text', text: 'command not found' }] } },
          { type: 'compaction', summary: 'ignored' },
        ],
      },
    }
    expect(suggestionConversation(ctx as never)).toBe([
      '[User]: 把 loader 改成异步',
      '[Assistant thinking]: 先看实现',
      '[Assistant]: 先看一下 现有实现',
      '[Assistant tool calls]: read(path="src/loader.ts"); read(path="src/index.ts")',
      '[Tool result]: export function load() {}',
      '[Tool result error]: command not found',
      '',
      '<read-files>',
      'src/index.ts',
      'src/loader.ts',
      '</read-files>',
    ].join('\n'))
  })

  test('a tool result is truncated rather than carried whole', () => {
    const ctx = {
      sessionManager: {
        getEntries: () => [
          {
            type: 'message',
            message: { role: 'assistant', content: [{ type: 'toolCall', name: 'read', arguments: { path: 'src/loader.ts' } }] },
          },
          { type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'x'.repeat(2000) }] } },
        ],
      },
    }
    const text = suggestionConversation(ctx as never)
    // pi 的 truncateForSummary：留头 + 标明截了多少字，不是整条塞进去。
    expect(text).toContain('[... 1600 more characters truncated]')
    expect(text).not.toContain('x'.repeat(2000))
    expect(text).toContain('<read-files>\nsrc/loader.ts\n</read-files>')
  })

  test('a long thinking block is truncated the same way', () => {
    const ctx = {
      sessionManager: {
        getEntries: () => [
          { type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'y'.repeat(1000) }, { type: 'text', text: '好的' }] } },
        ],
      },
    }
    const text = suggestionConversation(ctx as never)
    expect(text).toContain('[Assistant thinking]: ' + 'y'.repeat(400) + '\n[... 600 more characters truncated]')
    expect(text).toContain('[Assistant]: 好的')
  })

  test('the file inventory deduplicates, sorts and separates what was changed', () => {
    const ctx = {
      sessionManager: {
        getEntries: () => [
          {
            type: 'message',
            message: {
              role: 'assistant',
              content: [
                { type: 'toolCall', name: 'read', arguments: { path: 'z.ts' } },
                { type: 'toolCall', name: 'read', arguments: { path: 'a.ts' } },
                { type: 'toolCall', name: 'read', arguments: { path: 'a.ts' } },
                { type: 'toolCall', name: 'write', arguments: { path: 'n.ts', content: 'x'.repeat(400) } },
                { type: 'toolCall', name: 'edit', arguments: { path: 'a.ts' } },
                { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } },
                { type: 'toolCall', name: 'read', arguments: { path: 'src/loader.ts' } },
              ],
            },
          },
        ],
      },
    }
    const text = suggestionConversation(ctx as never)
    // 一条消息最多列两个调用，剩下的折成计数。
    expect(text).toContain('[Assistant tool calls]: read(path="z.ts"); read(path="a.ts"); …+5 more')
    // 被改过的文件不再算「只看过」；bash 没有 path，不进清单。
    expect(text).toContain('<read-files>\nsrc/loader.ts\nz.ts\n</read-files>')
    expect(text).toContain('<modified-files>\na.ts\nn.ts\n</modified-files>')
  })

  test('keeps the newest part of a long conversation and drops tool output bulk', () => {
    const long = 'x'.repeat(2000)
    const ctx = {
      sessionManager: {
        getEntries: () => [
          { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'old question' }] } },
          { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: long }] } },
          { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'newest question' }] } },
        ],
      },
    }
    const text = suggestionConversation(ctx as never)
    expect(text).toContain('earlier characters truncated')
    expect(text).toContain('newest question')
    expect(text).not.toContain('old question')
  })
})

describe('generic tool selection', () => {
  test('cannot enable or disable computer-use tools outside the dedicated mode switch', () => {
    expect(applyGuiToolSelection(['read', 'gui_task'], ['bash'])).toEqual(['read'])
    expect(applyGuiToolSelection(['read'], ['bash', 'gui_task'])).toEqual(['read', 'gui_task'])
  })
})

describe('fast search tools', () => {
  type Api = Parameters<typeof enableFastSearchTools>[0]
  const fake = (registered: string[], active: string[]) => {
    let current = [...active]
    return {
      active: () => current,
      pi: {
        getAllTools: () => registered.map((name) => ({ name })),
        getActiveTools: () => current,
        setActiveTools: (names: string[]) => { current = names },
      } as unknown as Api,
    }
  }

  test('打开 pi 默认没激活的 grep', () => {
    const { pi, active } = fake([...FAST_SEARCH_TOOLS, 'read', 'bash', 'edit', 'write'], ['read', 'bash', 'edit', 'write'])
    expect(enableFastSearchTools(pi)).toEqual(['grep'])
    expect(active()).toContain('grep')
    expect(active()).not.toContain('find')
    expect(active()).not.toContain('ls')
  })

  test('已经打开就不动', () => {
    const { pi, active } = fake(['grep', 'read'], ['read', 'bash', 'grep'])
    expect(enableFastSearchTools(pi)).toEqual([])
    expect(active()).toEqual(['read', 'bash', 'grep'])
  })

  test('运行时没注册的工具跳过', () => {
    const { pi } = fake(['grep'], ['read'])
    expect(enableFastSearchTools(pi)).toEqual(['grep'])
  })
})

describe('Expand web search tool', () => {
  test('defaults to an enabled Expand provider without exposing a key', () => {
    expect(resolveWebSearchSettings(null)).toEqual({
      enabled: true,
      baseUrl: 'https://api.expand.ai',
      providerId: 'expand',
      searchUrl: 'https://www.bing.com/search?q=',
    })
  })

  test('builds the three supported modes', () => {
    const settings = resolveWebSearchSettings(null)
    expect(webSearchRequest(settings, 'search', { query: 'pi coding agent' })).toEqual({
      url: 'https://api.expand.ai/v1/fetch?include=',
      body: { url: 'https://www.bing.com/search?q=pi%20coding%20agent' },
    })
    expect(webSearchRequest(settings, 'fetch', { url: 'https://example.com/docs' }).body).toEqual({ url: 'https://example.com/docs' })
    expect(webSearchRequest(settings, 'highlights', { url: 'https://example.com/docs', query: 'authentication', maxResults: 3, minScore: 0.4 }).body).toMatchObject({
      url: 'https://example.com/docs',
      highlights: { query: 'authentication', maxResults: 3, minScore: 0.4 },
    })
  })

  test('keeps web search active by default', () => {
    let active = ['read']
    const pi = {
      getAllTools: () => [{ name: WEB_SEARCH_TOOL }],
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => { active = names },
    }
    expect(enableWebSearchTool(pi)).toBe(true)
    expect(active).toEqual(['read', WEB_SEARCH_TOOL])
    expect(enableWebSearchTool(pi)).toBe(false)
  })

  test('bounds fetched Markdown while retaining the mode label', () => {
    expect(formatWebSearchResult('docs', 'result', 3)).toBe('Expand Web Search：docs\n\nres\n\n[结果过长，已截断]')
  })
})

describe('classifier image input', () => {
  test('accepts data URLs and keeps the declared mime type', () => {
    expect(readClassifierImages(['data:image/png;base64,QUJD'])).toEqual([{type:'image',data:'QUJD',mimeType:'image/png'}])
  })

  test('rejects a file the classifier cannot read before the request is made', () => {
    expect(() => readClassifierImages(['/tmp/notes.txt'])).toThrow('分类器不支持这种图片')
  })
})
