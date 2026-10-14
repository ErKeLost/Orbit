import { describe, expect, test } from 'bun:test'
import { applyGuiToolSelection, parseSessionMetadata } from '../src-tauri/resources/gui-extension'
import { enableFastSearchTools, FAST_SEARCH_TOOLS } from '../src-tauri/resources/search-tools'
import { enableWebSearchTool, formatWebSearchResult, resolveWebSearchSettings, webSearchRequest, WEB_SEARCH_TOOL } from '../src-tauri/resources/web-search'

describe('agent-generated session metadata', () => {
  test('accepts compact titles and supported semantic icons', () => {
    expect(parseSessionMetadata('```json\n{"title":"修复启动竞态","icon":"bug"}\n```')).toEqual({title:'修复启动竞态',icon:'bug'})
  })

  test('uses the default icon for an unsupported model choice', () => {
    expect(parseSessionMetadata('{"title":"分析会话","icon":"made-up"}')).toEqual({title:'分析会话',icon:'chat-teardrop-text'})
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
