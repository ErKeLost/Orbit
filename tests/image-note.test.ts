import { describe, expect, test } from 'bun:test'
import { withoutRuntimeImageNotes } from '../src/lib/image-note'

describe('transcript image metadata', () => {
  test('hides the coordinate-mapping note the runtime adds to a resized image', () => {
    const note = '[Image: original 3024x1888, displayed at 2000x1249. Multiply coordinates by 1.51 to map to original image.]'
    expect(withoutRuntimeImageNotes(note)).toBe('')
  })

  test('hides the format conversion note', () => {
    expect(withoutRuntimeImageNotes('[Image converted from image/heic to image/png.]')).toBe('')
  })

  test('keeps the surrounding user text', () => {
    const text = 'look at this\n[Image: original 3024x1888, displayed at 2000x1249. Multiply coordinates by 1.51 to map to original image.]\nsecond line'
    expect(withoutRuntimeImageNotes(text)).toBe('look at this\nsecond line')
  })

  test('leaves a real failure visible', () => {
    const omitted = '[Image omitted: could not be resized below the inline image size limit.]'
    expect(withoutRuntimeImageNotes(omitted)).toBe(omitted)
  })

  test('does not touch ordinary text that mentions the word image', () => {
    const text = 'the image is at /tmp/a.png\nImage: original idea'
    expect(withoutRuntimeImageNotes(text)).toBe(text)
  })
})
