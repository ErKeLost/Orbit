import { describe, expect, test } from 'bun:test'
import { applyGuiToolSelection, parseSessionMetadata } from '../src-tauri/resources/gui-extension'
import { enableFastSearchTools, FAST_SEARCH_TOOLS } from '../src-tauri/resources/search-tools'

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
