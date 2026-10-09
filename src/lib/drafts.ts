import { create } from "zustand"

/**
 * Unsaved editor buffers, keyed by file path.
 *
 * A draft is what the user typed since the file was opened. It lives here rather
 * than in the editor component because the editor unmounts whenever the pane
 * switches files, moves to another pane, or closes — and losing an edit because
 * a tab was clicked is not a thing an editor is allowed to do.
 *
 * The rules that follow from that:
 *
 * * a draft **survives closing its tab**: the dot on the tab is the warning, and
 *   reopening the file brings the edit back;
 * * it is only dropped by an explicit 保存 (after it is written) or by quitting
 *   the process — ⌘S is the whole ritual, on purpose.
 */
type DraftsState = {
  drafts: Record<string, string>
  setDraft: (path: string, text: string) => void
  dropDraft: (path: string) => void
  /** Rename a draft with its file, so an open edit follows a moved path. */
  moveDraft: (from: string, to: string) => void
}

export const useDrafts = create<DraftsState>((set) => ({
  drafts: {},
  setDraft: (path, text) => set((state) => (state.drafts[path] === text ? state : { drafts: { ...state.drafts, [path]: text } })),
  dropDraft: (path) => set((state) => {
    if (!(path in state.drafts)) return state
    const drafts = { ...state.drafts }
    delete drafts[path]
    return { drafts }
  }),
  moveDraft: (from, to) => set((state) => {
    if (!(from in state.drafts)) return state
    const drafts = { ...state.drafts }
    drafts[to] = drafts[from]!
    delete drafts[from]
    return { drafts }
  }),
}))

/** The unsaved text for a path, if any. */
export function draftFor(path: string | null | undefined): string | undefined {
  return path ? useDrafts.getState().drafts[path] : undefined
}

export function setDraftFor(path: string, text: string): void {
  useDrafts.getState().setDraft(path, text)
}

export function dropDraftFor(path: string): void {
  useDrafts.getState().dropDraft(path)
}

/** Whether a path has unsaved text. Subscribes: the tab dot reads it. */
export function useIsDirty(path: string | null | undefined): boolean {
  return useDrafts((state) => (path ? path in state.drafts : false))
}
