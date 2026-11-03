import { describe, expect, test } from 'bun:test'
import { workspaceExtraRootList } from '../src/lib/workspace-roots'
import type { Project } from '../src/lib/projects'

const project = (path: string, roots?: string[]): Project => ({ path, name: path.split('/').pop()!, ...(roots ? { roots } : {}) })

describe('workspace extra root list', () => {
  test('returns nothing when the project has no extra roots', () => {
    expect(workspaceExtraRootList('/work/pi-gui', {}, [project('/work/pi-gui')])).toEqual([])
  })

  test('reads attached roots from the session status', () => {
    const statuses = { 'gui-workspace': JSON.stringify({ roots: ['/work/shared-ui'] }) }
    expect(workspaceExtraRootList('/work/pi-gui', statuses, [project('/work/pi-gui')])).toEqual(['/work/shared-ui'])
  })

  test('falls back to the configured project roots before a session sync', () => {
    expect(workspaceExtraRootList('/work/pi-gui', {}, [project('/work/pi-gui', ['/work/docs'])])).toEqual(['/work/docs'])
  })

  test('unions both sources, session first, without duplicates or the home root', () => {
    const statuses = { 'gui-workspace': JSON.stringify({ roots: ['/work/shared-ui', '/work/pi-gui/'] }) }
    const projects = [project('/work/pi-gui', ['/work/docs', '/work/shared-ui'])]
    expect(workspaceExtraRootList('/work/pi-gui', statuses, projects)).toEqual(['/work/shared-ui', '/work/docs'])
  })

  test('survives a corrupted status payload', () => {
    expect(workspaceExtraRootList('/work/pi-gui', { 'gui-workspace': '{not json' }, [project('/work/pi-gui')])).toEqual([])
  })
})
