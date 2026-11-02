/** Reconcile Pi's streaming deltas with the authoritative text_end block. */
export function updateTextBlock(blocks: Map<number, string>, index: number, text: string, complete: boolean) {
  blocks.set(index, complete ? text : `${blocks.get(index) ?? ""}${text}`)
  return [...blocks].sort(([left], [right]) => left - right).map(([, value]) => value).join("")
}
