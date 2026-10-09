/** `/(^|\s)\/name(?=\s|$)` — mirror of Orbit's `SKILL_TOKEN_RE`. */
const SKILL_TOKEN_RE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*(?::[a-z0-9]+(?:-[a-z0-9]+)*)?)(?=\s|$)/g;

export type SkillTextPart = { text: string; skill: boolean };

/**
 * Split draft text at `/skill-name` tokens, so only commands the harness
 * actually knows are painted with the skill colour.
 */
export function skillTextParts(text: string, names: ReadonlySet<string>): SkillTextPart[] {
  if (!text) return [];
  if (names.size === 0) return [{ text, skill: false }];

  const parts: SkillTextPart[] = [];
  const push = (value: string, skill: boolean) => {
    if (!value) return;
    const last = parts[parts.length - 1];
    if (last && last.skill === skill) {
      last.text += value;
      return;
    }
    parts.push({ text: value, skill });
  };

  SKILL_TOKEN_RE.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = SKILL_TOKEN_RE.exec(text))) {
    const name = match[2];
    if (!name || !names.has(name)) continue;
    const start = match.index + (match[1] ?? "").length;
    const end = start + 1 + name.length;
    push(text.slice(cursor, start), false);
    push(text.slice(start, end), true);
    cursor = end;
  }
  push(text.slice(cursor), false);
  return parts;
}
