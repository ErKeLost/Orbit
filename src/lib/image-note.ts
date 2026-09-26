/** Metadata notes the agent runtime appends to the conversation next to an
 * inline image. They are hints for the model, not content the user wrote or
 * asked to read, so the desktop transcript hides them. */
const RUNTIME_IMAGE_NOTES = [
  /^\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by [\d.eE+-]+ to map to original image\.\]$/,
  /^\[Image converted from [a-z0-9/.+-]+ to [a-z0-9/.+-]+\.\]$/i,
];

/** Drop runtime image metadata lines. A real failure such as
 * "[Image omitted: …]" is left visible. */
export function withoutRuntimeImageNotes(text: string): string {
  if (!text.includes("[Image")) return text;
  return text
    .split("\n")
    .filter(line => !RUNTIME_IMAGE_NOTES.some(note => note.test(line.trim())))
    .join("\n");
}
