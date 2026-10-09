import { dropDraftFor, draftFor } from "./drafts"
import { writeTextFile } from "./git"
import { queryClient } from "./rpc"

/**
 * Write one file's unsaved buffer to disk.
 *
 * Saving is deliberately not a component concern: the editor's ⌘S, the toolbar's
 * 保存 button, and any future surface all have to mean the same thing — write the
 * draft, forget it, and let every reader of that file see the new contents.
 * Returns `false` when there was nothing to save, so ⌘S on a clean file is not an
 * error.
 */
export async function saveFileDraft(path: string): Promise<boolean> {
  const text = draftFor(path)
  if (text === undefined) return false
  await writeTextFile(path, text)
  dropDraftFor(path)
  // The read-only view and anything else holding this file's contents read the
  // same query; without this the saved text would not appear until a refetch.
  queryClient.setQueryData(["file", path], text)
  return true
}
