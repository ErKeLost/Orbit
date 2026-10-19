export type ComposerKeyEvent = {
  key: string
  shiftKey: boolean
  isComposing: boolean
  keyCode: number
}

export function shouldSubmitComposer(event: ComposerKeyEvent, composing: boolean) {
  return event.key === 'Enter' && !event.shiftKey && !composing && !event.isComposing && event.keyCode !== 229
}

/**
 * Whether a finished run should hand the caret back to the composer.
 *
 * The point is "the agent stopped talking, so I can type again" without having to
 * click. It is not unconditional: a run that settles in another pane must not
 * pull the caret out of whatever the reader is already typing into, and a modal
 * asking for input owns the keyboard until it is answered.
 */
export type ComposerFocusInput = {
  /** This composer's pane is the active one. */
  activePane: boolean
  /** A modal is waiting for input (approval, extension form, lightbox, screen). */
  modalOpen: boolean
  /** The caret already sits in another editable control (pane, editor, terminal, search). */
  editingElsewhere: boolean
  /** The reader has text selected (answering the run, about to copy) — focusing drops it. */
  selecting: boolean
  /** On a phone, focusing pops the soft keyboard over the answer the reader is reading. */
  handheld: boolean
}

export function shouldFocusComposer(input: ComposerFocusInput) {
  return input.activePane && !input.modalOpen && !input.editingElsewhere && !input.selecting && !input.handheld
}
