import { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from "react";
import { useWorkspace } from "../../lib/store";
import { ComposerHighlight } from "./ComposerHighlight";
import { paletteRequest, type PaletteRequest } from "./ComposerPalette";
import { draftKeyIntent, recallDraft, rememberDraft } from "./composerModel";
import type { MentionFile } from "./fileMentions";
import {
  PROMPT_SUGGESTION_DEBOUNCE_MS,
  PROMPT_SUGGESTION_STATUS,
  acceptSuggestion,
  claimTurnSuggestion,
  parseSuggestion,
  shouldAskNextStep,
  suggestionFor,
} from "./promptSuggestion";


export type DraftHandle = {
  clear: () => void;
  restore: (text: string) => void;
  focus: () => void;
  /** The textarea itself, so a focus decision can compare it with `document.activeElement`. */
  element: () => HTMLTextAreaElement | null;
  value: () => string;
  caret: () => number;
  setText: (text: string, caret: number) => void;
};

/**
 * The textarea is its own leaf so keystrokes never re-render the toolbar. Its
 * text is transparent: `ComposerHighlight` paints the same draft underneath, so
 * `/` and `@` tokens keep their palette styling once they land in the text.
 *
 * The prompt suggestion (联想) lives here too, for the same reason: the draft,
 * the caret and the ghost text are one piece of state, and the toolbar has no
 * business re-rendering when a suggestion lands.
 */
export const DraftField = memo(
  forwardRef<DraftHandle, {
    composerKey: string;
    placeholder: string;
    disabled: boolean;
    paletteOpen: boolean;
    skillNames: ReadonlySet<string>;
    mentionLabels: ReadonlyMap<string, MentionFile>;
    /** Ask Pi for a "what next" guess once a turn settles. */
    suggestEnabled: boolean;
    /** Identity of the conversation, so a stale "what next" guess can be dropped. */
    turnKey: string;
    /** Increments when a turn settles; 0 means "no turn finished in this view". */
    nextStepSeq: number;
    onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
    onHasValue: (has: boolean) => void;
    onPalette: (request: PaletteRequest | null) => void;
    onSuggest: (draft: string, turn: string) => void;

    /**
     * Shell-style recall of what the reader already sent. Returns true when the
     * arrow key was consumed as history, in which case it must not also move the
     * caret. The field decides *when* an arrow means history; the composer owns
     * the entries and the cursor into them.
     */
    onHistory: (direction: "up" | "down", caret: { start: number; end: number; length: number }) => boolean;
  }>(function DraftField(
    { composerKey, placeholder, disabled, paletteOpen, skillNames, mentionLabels, suggestEnabled, turnKey, nextStepSeq, onKeyDown, onHasValue, onPalette, onSuggest, onHistory },
    ref,
  ) {
      const [draft, setDraft] = useState(() => useWorkspace.getState().draft || recallDraft(composerKey) || "");
      const field = useRef<HTMLTextAreaElement>(null);
      const highlight = useRef<HTMLDivElement>(null);
      const caret = useRef(0);
      // The continuation is only ever appended, so "caret at the very end" is
      // the whole condition. Tracking the *boundary* rather than the offset
      // keeps moving the caret from re-rendering this leaf.
      const [atEnd, setAtEnd] = useState(true);
      /**
       * What the reader pressed Escape on. The "what next" guess is dismissed
       * per turn: it has no draft to be keyed on.
       */
      const ghostKey = draft.trim() ? draft : `turn:${turnKey}`;
      const [dismissed, setDismissed] = useState<string | null>(null);
      /**
       * Which finished turn we already paid for. Counted in turns, not in
       * `turnKey`: that key is derived from the transcript and can shift right
       * after a settle (Pi drops still-queued previews), which would otherwise
       * buy the same turn a second call.
       */
      const askedTurn = useRef(0);
      const reply = parseSuggestion(useWorkspace((state) => state.statuses[PROMPT_SUGGESTION_STATUS]));
      // A reply is used only for the draft (or the turn) it was asked about, so
      // a slow answer can never land on newer text or a newer conversation.
      const ghost = suggestEnabled && dismissed !== ghostKey ? suggestionFor(reply, draft, atEnd, turnKey) : null;
      const resize = (el: HTMLTextAreaElement | null) => {
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
      };
      useImperativeHandle(
        ref,
        () => ({
          clear: () => setDraft(""),
          restore: (text) => setDraft((current) => (current ? `${text}${current}` : text)),
          focus: () => field.current?.focus(),
          element: () => field.current,
          value: () => field.current?.value ?? "",
          caret: () => caret.current,
          setText: (text, position) => {
            caret.current = position;
            setDraft(text);
            // Recalled text can start with `/` or `@`: keep the palette in step
            // with the draft instead of waiting for the next keystroke.
            onPalette(paletteRequest(text, position));
            requestAnimationFrame(() => {
              const el = field.current;
              el?.focus();
              el?.setSelectionRange(position, position);
            });
          },
        }),
        [onPalette],
      );
      useEffect(() => {
        rememberDraft(composerKey, draft);
        onHasValue(Boolean(draft.trim()));
        resize(field.current);
      }, [composerKey, draft, onHasValue]);
      // 回合结束、输入框空着：猜「你下一句想说什么」。**一轮只问一次** ——
      // 重渲染、切光标、开合面板、把草稿删回空白都不会再花一次调用。
      // 打字过程本身永远不调模型：联想只在 agent 每次 run 结束时产生一次。
      useEffect(() => {
        const wanted = shouldAskNextStep({ enabled: suggestEnabled, paletteOpen, atEnd, draft, settleSeq: nextStepSeq, askedSeq: askedTurn.current });
        if (!wanted) return;
        const timer = window.setTimeout(() => {
          // 认领在真正发请求的那一刻才算数：分屏里另一个 pane 先到就它发。
          if (!claimTurnSuggestion(composerKey, turnKey)) return;
          askedTurn.current = nextStepSeq;
          onSuggest("", turnKey);
        }, PROMPT_SUGGESTION_DEBOUNCE_MS);
        return () => window.clearTimeout(timer);
      }, [atEnd, composerKey, draft, nextStepSeq, onSuggest, paletteOpen, suggestEnabled, turnKey]);
      // Extensions can push text into the editor (Pi `set_editor_text`).
      const external = useWorkspace((state) => state.draft);
      useEffect(() => {
        if (external) setDraft(external);
      }, [external]);
      const syncCaret = (el: HTMLTextAreaElement) => {
        caret.current = el.selectionStart ?? el.value.length;
        setAtEnd(caret.current >= el.value.length);
        onPalette(paletteRequest(el.value, caret.current));
      };
      /** Tab / →: take the continuation as real text. */
      const takeGhost = () => {
        const accepted = acceptSuggestion(draft, atEnd, ghost);
        if (!accepted) return false;
        caret.current = accepted.caret;
        setDraft(accepted.text);
        setAtEnd(true);
        onPalette(paletteRequest(accepted.text, accepted.caret));
        requestAnimationFrame(() => field.current?.setSelectionRange(accepted.caret, accepted.caret));
        return true;
      };
      return (
        <div className="relative">
          <div
            ref={highlight}
            aria-hidden
            className="composer-highlight pointer-events-none absolute inset-0 max-h-40 overflow-hidden whitespace-pre-wrap break-words px-3 py-3 font-sans text-sm leading-5.5 text-content"
          >
            <ComposerHighlight text={draft} names={skillNames} mentions={mentionLabels} ghost={ghost} />
          </div>
          <textarea
            ref={field}
            rows={1}
            spellCheck={false}
            value={draft}
            disabled={disabled}
            placeholder={ghost ? "" : placeholder}
            aria-label="消息"
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              syncCaret(event.currentTarget);
            }}
            onKeyDown={(event) => {
              const intent = draftKeyIntent(
                { key: event.key, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey, composing: event.nativeEvent.isComposing },
                { paletteOpen, hasGhost: Boolean(ghost) },
              );
              // While the palette is open it owns the arrows, Enter and Escape.
              if (intent === "palette") {
                event.preventDefault();
                return;
              }
              if (intent === "history") {
                const el = event.currentTarget;
                if (onHistory(event.key === "ArrowUp" ? "up" : "down", { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0, length: el.value.length })) {
                  event.preventDefault();
                  return;
                }
              }
              // While an IME is composing, Tab and → belong to the candidate list.
              if (intent === "ghost") {
                // ArrowRight at the very end of the text does nothing otherwise,
                // so taking it costs the reader nothing.
                if (takeGhost()) {
                  event.preventDefault();
                  return;
                }
              }
              if (intent === "dismiss-ghost") {
                event.preventDefault();
                setDismissed(ghostKey);
                return;
              }
              onKeyDown(event);
            }}
            onKeyUp={(event) => syncCaret(event.currentTarget)}
            onClick={(event) => syncCaret(event.currentTarget)}
            onSelect={(event) => syncCaret(event.currentTarget)}
            onScroll={(event) => {
              const el = event.currentTarget;
              if (!highlight.current) return;
              highlight.current.scrollTop = el.scrollTop;
              highlight.current.scrollLeft = el.scrollLeft;
            }}
            className="composer-field scrollbar-none relative max-h-40 w-full resize-none overflow-x-hidden whitespace-pre-wrap break-words bg-transparent px-3 py-3 font-sans text-sm leading-5.5 outline-none placeholder:overflow-hidden placeholder:text-ellipsis placeholder:whitespace-nowrap"
          />
        </div>
      );
    },
  ),
);
