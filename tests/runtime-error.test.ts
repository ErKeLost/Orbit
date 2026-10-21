import { describe, expect, test } from 'bun:test'
import { projectDisconnected, QUIET_FAILED_POLLS, runtimeErrorToShow } from '../src/lib/runtime-error'

/**
 * The banner under the title bar is the only place a poll failure shows up, and
 * the poll runs every 5 seconds against a process that can be mid-restart. These
 * are the three cases that used to look identical: a blip, a real outage, and a
 * failure nobody should ever see.
 */
describe('runtime heartbeat errors', () => {
  const notConnected = new Error('项目尚未连接')

  test('the bridge wording is recognised on Error and on plain strings', () => {
    expect(projectDisconnected(notConnected)).toBe(true)
    expect(projectDisconnected('项目尚未连接')).toBe(true)
    expect(projectDisconnected(new Error('Pi prompt 响应超时'))).toBe(false)
  })

  test('a reconnect in progress stays quiet', () => {
    expect(runtimeErrorToShow(notConnected, 0)).toBeNull()
    expect(runtimeErrorToShow(notConnected, QUIET_FAILED_POLLS - 1)).toBeNull()
  })

  test('a process that never comes back is reported once the polls add up', () => {
    expect(runtimeErrorToShow(notConnected, QUIET_FAILED_POLLS)).toBe('Error: 项目尚未连接')
  })

  test('other failures show on the first poll: they do not repair themselves', () => {
    expect(runtimeErrorToShow(new Error('Pi prompt 响应超时'), 0)).toBe('Error: Pi prompt 响应超时')
  })

  test('no error renders nothing', () => {
    expect(runtimeErrorToShow(null, 0)).toBeNull()
    expect(runtimeErrorToShow(undefined, 3)).toBeNull()
  })
})
