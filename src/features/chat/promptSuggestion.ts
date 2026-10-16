/**
 * Codex-style prompt completion ("联想"): when a run ends with the composer
 * empty, the composer asks Pi's own model what the reader probably wants next
 * and paints the guess as ghost text after the caret. Tab or → takes it,
 * Escape drops it. Typing never costs a model call — the guess is produced
 * once per finished run.
 *
 * The awkward parts are "is this reply still about the text on screen" and
 * "does the model's continuation actually continue instead of restating", so
 * they live here as pure functions. The component only decides *when* to ask.
 */

/**
 * Status key the `gui-suggest` extension command publishes to.
 *
 * The payload echoes the draft it was computed for: that echo is the whole
 * caching and staleness story. A reply is used only for the exact draft it was
 * asked about, so a slow answer can never be painted onto newer text, and no
 * request id or cancellation bookkeeping is needed.
 */
export const PROMPT_SUGGESTION_STATUS = "gui-suggest";

/** Preference key: suggestions are a model call per pause, so they are opt-in. */
export const PROMPT_SUGGESTION_KEY = "orbit.promptSuggestion";

/** Typing pause before asking. Below ~400ms every sentence costs several calls. */
export const PROMPT_SUGGESTION_DEBOUNCE_MS = 500;

/** A continuation longer than this is a model that ignored the instructions. */
const MAX_SUGGESTION_CHARS = 160;

/** Shortest suffix overlap worth removing; shorter ones are real continuations. */
const MIN_OVERLAP = 6;

export type SuggestionPayload = {
  /** The draft the reply was computed for. `""` means "guess the next sentence". */
  draft: string;
  /** Which turn a next-sentence guess belongs to; absent on a typing completion. */
  turn?: string;
  text: string;
};

/**
 * Identity of the conversation as it stands right now.
 *
 * A next-sentence guess is only valid for the turn it was made after: the
 * moment the reader sends (or receives) anything else, it has to disappear
 * rather than being painted into a conversation that has moved on.
 */
export function transcriptTurn(messages: readonly { message: { role: string; timestamp?: number } }[]): string {
  const last = messages[messages.length - 1];
  if (!last) return "0";
  return `${messages.length}:${last.message.timestamp ?? ""}`;
}

export function loadPromptSuggestion(): boolean {
  try {
    // 默认开启：这是「回合结束后猜你下一句」的入口，关掉只需在输入框 `+` 里点一下。
    return localStorage.getItem(PROMPT_SUGGESTION_KEY) !== "0";
  } catch {
    return true;
  }
}

export function savePromptSuggestion(enabled: boolean): void {
  try {
    if (enabled) localStorage.removeItem(PROMPT_SUGGESTION_KEY);
    else localStorage.setItem(PROMPT_SUGGESTION_KEY, "0");
  } catch {
    /* storage unavailable */
  }
}

/** Parse the `gui-suggest` status payload; anything malformed is "no answer". */
export function parseSuggestion(raw: string | null | undefined): SuggestionPayload | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { draft?: unknown; turn?: unknown; text?: unknown };
    if (typeof value.draft !== "string" || typeof value.text !== "string") return null;
    return { draft: value.draft, text: value.text, ...(typeof value.turn === "string" ? { turn: value.turn } : {}) };
  } catch {
    return null;
  }
}

/**
 * The ghost text to paint, or null.
 *
 * `caretAtEnd` is not the caret offset but whether the caret sits at the very
 * end of the draft: the continuation is only ever appended there, so any other
 * position has to be left alone.
 */
export function suggestionFor(
  payload: SuggestionPayload | null,
  draft: string,
  caretAtEnd: boolean,
  turn: string,
): string | null {
  if (!payload || payload.draft !== draft) return null;
  if (!caretAtEnd) return null;
  // 空输入框里的是「下一句」猜测：它属于某一轮，不属于某一个草稿，所以用
  // 回合身份判断新鲜度（用户一旦发出下一句，上一轮的猜测就不会再对上）。
  if (!draft.trim() && payload.turn !== turn) return null;
  const text = stripRepeatedDraft(draft, payload.text.replace(/\s+/g, " ").trim());
  if (!text) return null;
  if (Array.from(text).length > MAX_SUGGESTION_CHARS) return null;
  return text;
}

/**
 * Drop a prefix of `text` that merely restates the end of the draft.
 *
 * Models often answer with the finished sentence rather than its tail. Only a
 * *long* overlap counts: in `帮我看看` → `帮我看看这个函数` the six characters
 * are unambiguously a restatement, while a two-character overlap is as likely to
 * be the start of a genuine continuation (它 → 它们).
 */
function stripRepeatedDraft(draft: string, text: string): string {
  const longest = Math.min(draft.length, text.length);
  for (let size = longest; size >= MIN_OVERLAP; size--) {
    if (draft.endsWith(text.slice(0, size))) return text.slice(size).trim();
  }
  return text;
}

/**
 * One-shot claim per finished turn.
 *
 * `shouldAskNextStep` is per component, and the shell can show the same session in
 * two panes at once — each pane has its own counter, so on its own it would ask
 * twice for one finished turn. The claim is deliberately module-level and taken at
 * the moment the request actually goes out, so whichever pane gets there first is
 * the one that pays.
 */
const claimedTurns = new Map<string, string>();

export function claimTurnSuggestion(connection: string, turn: string): boolean {
  if (claimedTurns.get(connection) === turn) return false;
  claimedTurns.set(connection, turn);
  return true;
}

/**
 * Whether to ask for a "what next" guess.
 *
 * `settleSeq` counts finished turns and only ever grows, so `settleSeq > askedSeq`
 * is exactly "the reader has not been charged for this turn yet". That makes the
 * call once-per-turn by construction: re-rendering, moving the caret, opening and
 * closing the palette, or clearing the draft back to empty all leave both numbers
 * alone. `settleSeq === 0` means no turn finished in this view (a freshly opened
 * session, or a turn that ended while the pane was hidden), and that must not cost
 * a call either.
 */
export function shouldAskNextStep(input: {
  enabled: boolean;
  paletteOpen: boolean;
  atEnd: boolean;
  draft: string;
  settleSeq: number;
  askedSeq: number;
}): boolean {
  if (!input.enabled || input.paletteOpen || !input.atEnd) return false;
  if (input.draft.trim()) return false;
  return input.settleSeq > input.askedSeq;
}

/**
 * Apply a suggestion to the draft. Returns the new text and where the caret
 * goes, or null when the caret is not at the end (nothing to append to).
 */
export function acceptSuggestion(
  draft: string,
  caretAtEnd: boolean,
  suggestion: string | null,
): { text: string; caret: number } | null {
  if (!suggestion || !caretAtEnd) return null;
  const text = `${draft}${suggestion}`;
  return { text, caret: text.length };
}
