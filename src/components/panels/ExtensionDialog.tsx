import { useState } from "react";
import type { UiRequest } from "../../lib/protocol";
import { answerDialog, report } from "../../lib/rpc";
import { Check, MessageSquare } from "../../shared/ui/icons";
import { QUESTION_TITLE, questionsFromPayload } from "../../../src-tauri/resources/question";
import { QuestionDialog } from "./QuestionDialog";

/**
 * Pi extension UI requests (`select`, `confirm`, `input`, `editor`).
 *
 * A question replaces the composer until it is answered. Everything else is a
 * section of the composer box — not a second card parked above it.
 */
export function ExtensionDialog({ dialog, embedded = false }: { dialog: UiRequest; embedded?: boolean }) {
  const [value, setValue] = useState(dialog.method === "editor" ? (dialog as { prefill?: string }).prefill ?? "" : "");
  const [choice, setChoice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  if (!["confirm", "select", "input", "editor"].includes(dialog.method)) return null;
  if (dialog.method === "select" && dialog.title === QUESTION_TITLE) {
    const questions = questionsFromPayload(dialog.options[0] ?? "");
    if (questions) return <QuestionDialog dialog={dialog} questions={questions} />;
  }
  const rawTitle = "title" in dialog && dialog.title ? dialog.title : "Pi 扩展";
  const secret = rawTitle.startsWith("orbit:secret");
  const title = secret ? rawTitle.slice("orbit:secret".length).replace(/^[:\s]+/, "") || "需要一个密钥" : rawTitle;

  async function answer(data: { value?: string; confirmed?: boolean; cancelled?: boolean }) {
    setPending(true);
    try {
      await answerDialog(dialog, data);
    } catch (error) {
      report(error);
    } finally {
      setPending(false);
    }
  }

  const ready = dialog.method === "select" ? choice != null : dialog.method === "confirm" ? true : value.trim().length > 0;
  return (
    <form
      data-question-form
      className={embedded ? "border-b border-stroke px-3 py-2.5" : "mb-1.5 overflow-hidden rounded-lg border border-line bg-fill-weak px-3 py-2.5 backdrop-blur-sm has-focus:border-line-strong"}
      onSubmit={(event) => {
          event.preventDefault();
          if (dialog.method === "confirm") void answer({ confirmed: true });
          else if (dialog.method === "select" && choice) void answer({ value: choice });
          else void answer({ value });
        }}
      >
        <div className="flex items-center gap-1.5">
          <MessageSquare className="size-3.5 shrink-0 text-ink-3" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 truncate text-2xs text-ink-3">{title}</span>
          <button type="button" disabled={pending} className="h-7 shrink-0 rounded-md px-2 text-2xs text-ink-2 hover:bg-fill-strong hover:text-ink-1 disabled:opacity-40" onClick={() => void answer({ cancelled: true })}>
            Skip
          </button>
        </div>
        <div className="mt-2">
          {dialog.method === "confirm" ? <p className="whitespace-pre-wrap text-ui font-medium leading-snug text-ink-1">{dialog.message}</p> : null}
          {dialog.method === "select" ? (
            <div className="mt-1.5 flex max-h-52 flex-col gap-1 overflow-y-auto">
              {dialog.options.map((option) => {
                const active = choice === option;
                return (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={active}
                    data-picked={active}
                    onClick={() => setChoice(option)}
                    onDoubleClick={() => void answer({ value: option })}
                    className="question-option flex w-full items-start gap-2 px-2.5 py-2 text-left"
                  >
                    <span aria-hidden className={`mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-full border ${active ? "border-accent bg-accent text-accent-foreground" : "border-line-strong"}`}>
                      {active ? <Check className="size-2.5" strokeWidth={2.5} /> : null}
                    </span>
                    <span className="block min-w-0 flex-1 text-ui text-ink-1">{option}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
          {secret ? (
            <div className="mt-1.5">
              <p className="text-2xs leading-4 text-ink-3">只保存在这台机器上，不会写入对话。</p>
              <input
                autoFocus
                type="password"
                value={value}
                autoComplete="off"
                spellCheck={false}
                placeholder={(dialog as { placeholder?: string }).placeholder || "值，或 op://vault/item/field、!命令"}
                onChange={(event) => setValue(event.target.value)}
                className="mt-1.5 w-full rounded-md border border-line bg-transparent px-2 py-1 text-ui text-ink-1 outline-none placeholder:text-ink-3 focus:border-line-strong"
              />
            </div>
          ) : null}
          {!secret && (dialog.method === "input" || dialog.method === "editor") ? (
            <textarea
              autoFocus
              value={value}
              rows={dialog.method === "editor" ? 6 : 2}
              placeholder={dialog.method === "input" ? (dialog as { placeholder?: string }).placeholder : ""}
              onChange={(event) => setValue(event.target.value)}
              className="mt-1.5 w-full resize-y rounded-md border border-line bg-transparent px-2 py-1 text-ui text-ink-1 outline-none placeholder:text-ink-3 focus:border-line-strong"
            />
          ) : null}
        </div>
        <div className="mt-2.5 flex items-center justify-end gap-2">
          {dialog.method === "confirm" ? (
            <button type="button" disabled={pending} className="h-7 shrink-0 rounded-md px-2 text-2xs text-ink-2 hover:bg-fill-strong hover:text-ink-1 disabled:opacity-40" onClick={() => void answer({ confirmed: false })}>
              No
            </button>
          ) : null}
          <button type="submit" disabled={!ready || pending} className="primary-action h-7 rounded-md px-2.5 text-2xs font-medium">
            {secret ? "保存" : dialog.method === "confirm" ? "Confirm" : "Continue"}
          </button>
        </div>
    </form>
  );
}
