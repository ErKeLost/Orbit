import { describe, expect, test } from 'bun:test'
import { shouldFocusComposer, shouldSubmitComposer } from '../src/lib/composer'

const enter = {key:'Enter',shiftKey:false,isComposing:false,keyCode:13}

describe('composer Enter handling', () => {
  test('submits an ordinary Enter key', () => {
    expect(shouldSubmitComposer(enter, false)).toBe(true)
  })

  test('does not submit while a Chinese IME is selecting text', () => {
    expect(shouldSubmitComposer({...enter,isComposing:true}, false)).toBe(false)
    expect(shouldSubmitComposer({...enter,keyCode:229}, false)).toBe(false)
    expect(shouldSubmitComposer(enter, true)).toBe(false)
  })

  test('keeps Shift Enter available for a new line', () => {
    expect(shouldSubmitComposer({...enter,shiftKey:true}, false)).toBe(false)
  })
})

const idle = {activePane:true,modalOpen:false,editingElsewhere:false,selecting:false,handheld:false}

describe('composer focus after a run settles', () => {
  test('takes the caret when the active pane finished and nothing else holds it', () => {
    expect(shouldFocusComposer(idle)).toBe(true)
  })

  test('leaves a caret that is already busy elsewhere alone', () => {
    expect(shouldFocusComposer({...idle,editingElsewhere:true})).toBe(false)
  })

  test('never steals focus for a run that settled in another pane', () => {
    expect(shouldFocusComposer({...idle,activePane:false})).toBe(false)
  })

  test('waits for a modal that is asking for input', () => {
    expect(shouldFocusComposer({...idle,modalOpen:true})).toBe(false)
  })

  test('keeps a text selection the reader is about to copy', () => {
    expect(shouldFocusComposer({...idle,selecting:true})).toBe(false)
  })

  test('does not pop the soft keyboard on a phone', () => {
    expect(shouldFocusComposer({...idle,handheld:true})).toBe(false)
  })
})
