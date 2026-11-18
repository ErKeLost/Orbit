import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { UiRequest } from "../../lib/protocol";
import { answerDialog, report } from "../../lib/rpc";
import { Check, ChevronDown, ChevronUp } from "../../shared/ui/icons";
import {
  encodeAnswers,
  nextQuestionDraft,
  questionAnswer,
  questionSummary,
  type QuestionDraft,
  type QuestionPrompt,
} from "../../../src-tauri/resources/question";

const emptyDraft = (): QuestionDraft => ({ selected: [], customText: "", customOn: false });
const IS_MAC = typeof navigator !== "undefined" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform);
const CUSTOM_LABEL = "Type your own answer…";

/**
 * OpenCode's classic question dock: one prompt at a time, options plus a typed
 * answer, then the whole set goes back as one select value. Dismiss ends the turn.
 */
export function QuestionDialog({ dialog, questions }: { dialog: UiRequest; questions: QuestionPrompt[] }) {
  const [tab, setTab] = useState(0);
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() => questions.map(emptyDraft));
  const [pending, setPending] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [editing, setEditing] = useState(false);
  const [focus, setFocus] = useState(0);
  const rootRef = useRef<HTMLFormElement>(null);
  const optionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const customRef = useRef<HTMLButtonElement>(null);
  const customInput = useRef<HTMLInputElement>(null);
  const question = questions[tab];
  const draft = drafts[tab] ?? emptyDraft();
  const options = question?.options ?? [];
  const count = options.length + 1;
  const last = tab >= questions.length - 1;
  const multi = question?.multiple === true;

  function update(next: QuestionDraft) {
    setDrafts((rows) => rows.map((row, index) => (index === tab ? next : row)));
  }

  function answered(index: number) {
    const item = questions[index];
    return !!item && questionAnswer(item, drafts[index] ?? emptyDraft()).length > 0;
  }

  async function reply(data: { value?: string; cancelled?: boolean }) {
    setPending(true);
    try {
      await answerDialog(dialog, data);
    } catch (error) {
      report(error);
      setPending(false);
    }
  }

  function submit(rows: QuestionDraft[] = drafts) {
    const answers = questions.map((item, index) => questionAnswer(item, rows[index] ?? emptyDraft()));
    void reply({ value: encodeAnswers(answers) });
  }

  function dismiss() {
    if (pending) return;
    void reply({ cancelled: true });
  }

  function pickFocus(index = tab) {
    const item = questions[index];
    const row = drafts[index] ?? emptyDraft();
    if (!item) return 0;
    if (row.customOn) return item.options.length;
    const selected = item.options.findIndex((option) => row.selected.includes(option.label));
    return Math.max(0, selected);
  }

  function focusRow(index: number) {
    const next = Math.max(0, Math.min(count - 1, index));
    setFocus(next);
    if (editing) return;
    const el = next === options.length ? customRef.current : optionRefs.current[next];
    el?.focus({ preventScroll: true });
  }

  function jump(index: number) {
    if (pending || index === tab || index < 0 || index >= questions.length) return;
    setTab(index);
    setEditing(false);
    setFocus(pickFocus(index));
  }

  function advance() {
    if (pending) return;
    if (editing) setEditing(false);
    if (last) submit();
    else jump(tab + 1);
  }

  function back() {
    if (pending || tab <= 0) return;
    jump(tab - 1);
  }

  function selectOption(index: number) {
    if (pending) return;
    const option = options[index];
    if (!option) return;
    setEditing(false);
    update(nextQuestionDraft(draft, { type: "pick", value: option.label, multiple: multi }));
  }

  function customToggle() {
    if (pending) return;
    setFocus(options.length);
    if (!multi || !draft.customOn) {
      update(nextQuestionDraft(draft, { type: "custom-select", multiple: multi }));
      setEditing(true);
      customInput.current?.focus();
      return;
    }
    update(nextQuestionDraft(draft, { type: "custom-deselect" }));
    setEditing(false);
    customRef.current?.focus();
  }

  useEffect(() => {
    focusRow(pickFocus());
    // Focus the first answer once, when the dock takes the composer's place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (editing) return;
    const el = focus === options.length ? customRef.current : optionRefs.current[focus];
    if (el && document.activeElement !== el && rootRef.current?.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, [focus, editing, options.length, tab]);

  function onKeyDown(event: ReactKeyboardEvent) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (editing) {
        event.stopPropagation();
        setEditing(false);
        focusRow(options.length);
        return;
      }
      dismiss();
      return;
    }
    const previous = IS_MAC
      ? event.metaKey && !event.ctrlKey && !event.altKey && event.key === "["
      : event.altKey && !event.ctrlKey && !event.metaKey && event.key === "ArrowLeft";
    if (previous) {
      if (event.repeat) return;
      event.preventDefault();
      back();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key === "Enter") {
      if (event.repeat) return;
      event.preventDefault();
      advance();
      return;
    }
    if (editing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (/^[1-9]$/.test(event.key)) {
      if (event.repeat || minimized || pending) return;
      const index = Number(event.key) - 1;
      if (index >= count) return;
      event.preventDefault();
      if (index === options.length) {
        customToggle();
        return;
      }
      selectOption(index);
      focusRow(index);
      return;
    }
    const inOptions = event.target instanceof HTMLElement && event.target.closest("[data-question-options]");
    if (!inOptions) return;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      focusRow(focus + 1);
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      focusRow(focus - 1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      focusRow(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      focusRow(count - 1);
    }
  }

  if (!question) return null;
  return (
    <form
      ref={rootRef}
      data-question-form
      data-composer-box
      data-component="session-question-dock"
      className="rounded-lg border border-line bg-fill-weak px-3 py-2.5 backdrop-blur-sm has-focus:border-line-strong"
      onSubmit={(event) => {
        event.preventDefault();
        advance();
      }}
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-2xs text-ink-3">{questionSummary(tab, questions.length)}</span>
        {questions.length > 1 ? (
          <div className="flex shrink-0 items-center gap-0.5" data-question-progress>
            {questions.map((item, index) => (
              <button
                key={`${item.header}-${index}`}
                type="button"
                disabled={pending}
                aria-current={index === tab ? "step" : undefined}
                aria-label={item.header || `Questions ${index + 1}`}
                title={item.header}
                onClick={() => jump(index)}
                className="grid size-5 place-items-center rounded-sm disabled:opacity-40"
              >
                <span
                  className={`block h-0.5 w-3.5 rounded-full ${
                    index === tab ? "bg-ink-1" : answered(index) ? "bg-ink-2" : "bg-fill-strong"
                  }`}
                />
              </button>
            ))}
          </div>
        ) : null}
        <button
          type="button"
          disabled={pending}
          aria-label={minimized ? "Restore question" : "Minimize question"}
          className="grid size-6 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-fill-strong hover:text-ink-1 disabled:opacity-40"
          onClick={() => setMinimized((value) => !value)}
        >
          {minimized ? <ChevronUp className="size-3.5" strokeWidth={1.75} /> : <ChevronDown className="size-3.5" strokeWidth={1.75} />}
        </button>
      </div>
      <p className={`mt-2 whitespace-pre-wrap text-ui font-medium text-ink-1 ${minimized ? "line-clamp-3" : ""}`}>
        {question.question}
      </p>
      {minimized ? null : <p className="mt-1 text-2xs text-ink-3">{multi ? "Select all answers that apply" : "Select one answer"}</p>}
      <div
        data-question-options
        role={multi ? "group" : "radiogroup"}
        aria-label={question.question}
        hidden={minimized}
        className="mt-2 flex max-h-64 flex-col gap-1 overflow-y-auto"
      >
        {options.map((option, index) => {
          const picked = draft.selected.includes(option.label);
          return (
            <div
              key={option.label}
              ref={(el) => {
                optionRefs.current[index] = el;
              }}
              role={multi ? "checkbox" : "radio"}
              aria-checked={picked}
              aria-keyshortcuts={index < 9 ? String(index + 1) : undefined}
              tabIndex={pending ? -1 : 0}
              data-picked={picked}
              onFocus={() => setFocus(index)}
              onClick={() => {
                if (pending) return;
                selectOption(index);
                setFocus(index);
              }}
              onKeyDown={(event) => {
                if (event.key !== " " && event.key !== "Enter") return;
                if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
                event.preventDefault();
                selectOption(index);
              }}
              className={`flex w-full cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                picked ? "border-line-strong bg-accent-soft" : "border-line hover:bg-fill"
              }`}
            >
              <Mark multi={multi} picked={picked} />
              <span className="min-w-0 flex-1">
                <span className="block text-ui text-ink-1">{option.label}</span>
                {option.description ? <span className="mt-0.5 block text-2xs text-ink-3">{option.description}</span> : null}
              </span>
              {index < 9 ? <Shortcut n={index + 1} /> : null}
            </div>
          );
        })}
        <div
          data-custom="true"
          data-picked={draft.customOn}
          className={`flex min-h-10 items-center gap-2 rounded-md border px-2.5 transition-colors ${draft.customOn ? "border-line-strong bg-accent-soft" : "border-line"}`}
          onClick={(event) => {
            if (event.target !== event.currentTarget || pending) return;
            setFocus(options.length);
            update(nextQuestionDraft(draft, { type: "custom-select", multiple: multi }));
            setEditing(true);
            customInput.current?.focus();
          }}
        >
          <button
            ref={customRef}
            type="button"
            role={multi ? "checkbox" : "radio"}
            aria-checked={draft.customOn}
            aria-label={CUSTOM_LABEL}
            aria-keyshortcuts={count <= 9 ? String(count) : undefined}
            disabled={pending}
            onFocus={() => setFocus(options.length)}
            onClick={customToggle}
            className="grid size-4 shrink-0 place-items-center rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
          >
            <Mark multi={multi} picked={draft.customOn} />
          </button>
          <input
            ref={customInput}
            value={draft.customText}
            disabled={pending}
            aria-label={CUSTOM_LABEL}
            placeholder={CUSTOM_LABEL}
            onFocus={() => {
              setFocus(options.length);
              setEditing(true);
            }}
            onBlur={() => setEditing(false)}
            onClick={() => update(nextQuestionDraft(draft, { type: "custom-select", multiple: multi }))}
            onChange={(event) => update(nextQuestionDraft(draft, { type: "custom-input", text: event.target.value, multiple: multi }))}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "Escape") return;
              if ((event.metaKey || event.ctrlKey) && !event.altKey) return;
              if (event.key !== "Enter") return;
              event.preventDefault();
              setEditing(false);
              customRef.current?.focus();
            }}
            className="min-w-0 flex-1 bg-transparent text-ui text-ink-1 outline-none placeholder:text-ink-3 disabled:opacity-40"
          />
          {count <= 9 ? <Shortcut n={count} /> : null}
        </div>
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <button type="button" disabled={pending} aria-keyshortcuts="Escape" className="h-7 rounded-md px-2 text-2xs text-ink-2 hover:bg-fill-strong hover:text-ink-1 disabled:opacity-40" onClick={dismiss}>
          Dismiss
        </button>
        <div className="flex items-center gap-1.5">
          {tab > 0 ? (
            <button
              type="button"
              disabled={pending}
              aria-keyshortcuts={IS_MAC ? "Meta+[" : "Alt+ArrowLeft"}
              title={IS_MAC ? "Back ⌘[" : "Back Alt+←"}
              className="h-7 rounded-md border border-line px-2.5 text-2xs text-ink-2 hover:bg-fill-strong hover:text-ink-1 disabled:opacity-40"
              onClick={back}
            >
              Back
            </button>
          ) : null}
          <button
            type="submit"
            disabled={pending}
            aria-keyshortcuts="Meta+Enter Control+Enter"
            title={IS_MAC ? `${last ? "Submit" : "Next"} ⌘⏎` : `${last ? "Submit" : "Next"} Ctrl+Enter`}
            className={last ? "primary-action h-7 rounded-md px-2.5 text-2xs font-medium" : "h-7 rounded-md border border-line px-2.5 text-2xs text-ink-2 hover:bg-fill-strong hover:text-ink-1 disabled:opacity-40"}
          >
            {last ? "Submit" : "Next"}
          </button>
        </div>
      </div>
    </form>
  );
}

function Mark({ multi, picked }: { multi: boolean; picked: boolean }) {
  return (
    <span
      aria-hidden
      className={`mt-0.5 grid size-3.5 shrink-0 place-items-center border ${multi ? "rounded-xs" : "rounded-full"} ${
        picked ? "border-accent bg-accent text-accent-foreground" : "border-line-strong"
      }`}
    >
      {picked ? multi ? <Check className="size-2.5" strokeWidth={2.5} /> : <span className="size-1.5 rounded-full bg-accent-foreground" /> : null}
    </span>
  );
}

function Shortcut({ n }: { n: number }) {
  return (
    <kbd className="grid h-5 min-w-5 place-items-center self-center rounded-keycap border border-line bg-fill-weak px-1 text-2xs leading-none text-ink-3">
      {n}
    </kbd>
  );
}
