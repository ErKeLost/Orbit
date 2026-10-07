import { useState } from "react";
import type { UiRequest } from "../../lib/protocol";
import { answerDialog, report } from "../../lib/rpc";
import { Check, MessageSquare } from "../../shared/ui/icons";

/**
 * Pi extension UI requests (`select`, `confirm`, `input`, `editor`) in
 * MonoCode's QuestionForm card, docked above the composer.
 */
export function ExtensionDialog({ dialog }: { dialog: UiRequest }) {
  const [value, setValue] = useState(dialog.method === "editor" ? (dialog as { prefill?: string }).prefill ?? "" : "");
  const [choice, setChoice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  if (!["confirm", "select", "input", "editor"].includes(dialog.method)) return null;
  const title = "title" in dialog && dialog.title ? dialog.title : "Pi 扩展";

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
    <div className="px-1.5 pb-1.5" data-question-form>
      <form
        className="rounded-lg border border-content/10 bg-content/3 px-3 py-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (dialog.method === "confirm") void answer({ confirmed: true });
          else if (dialog.method === "select" && choice) void answer({ value: choice });
          else void answer({ value });
        }}
      >
        <div className="flex items-center gap-1.5">
          <MessageSquare className="size-3.5 shrink-0 text-content/45" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 truncate text-[11px] text-content/50">{title}</span>
          <button type="button" disabled={pending} className="h-6 shrink-0 rounded-md px-1.5 text-[11px] text-content/55 hover:bg-content/10 hover:text-content" onClick={() => void answer({ cancelled: true })}>
            Skip
          </button>
        </div>
        <div className="mt-2">
          {dialog.method === "confirm" ? <p className="whitespace-pre-wrap text-[13px] font-medium leading-snug text-content">{dialog.message}</p> : null}
          {dialog.method === "select" ? (
            <div className="mt-1.5 flex max-h-52 flex-col gap-1 overflow-y-auto">
              {dialog.options.map((option) => {
                const active = choice === option;
                return (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setChoice(option)}
                    onDoubleClick={() => void answer({ value: option })}
                    className={`flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                      active ? "border-content/35 bg-selection" : "border-content/10 hover:bg-content/5"
                    }`}
                  >
                    <span aria-hidden className={`mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-full border ${active ? "border-content bg-content text-background-base" : "border-content/30"}`}>
                      {active ? <Check className="size-2.5" strokeWidth={2.5} /> : null}
                    </span>
                    <span className="block min-w-0 flex-1 text-[12px] leading-snug text-content">{option}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
          {dialog.method === "input" || dialog.method === "editor" ? (
            <textarea
              autoFocus
              value={value}
              rows={dialog.method === "editor" ? 6 : 2}
              placeholder={dialog.method === "input" ? (dialog as { placeholder?: string }).placeholder : ""}
              onChange={(event) => setValue(event.target.value)}
              className="mt-1.5 w-full resize-y rounded-md border border-content/15 bg-transparent px-2 py-1 text-[12px] text-content outline-none placeholder:text-content/35 focus:border-content/30"
            />
          ) : null}
        </div>
        <div className="mt-2.5 flex items-center justify-end gap-2">
          {dialog.method === "confirm" ? (
            <button type="button" disabled={pending} className="h-6 shrink-0 rounded-md px-1.5 text-[11px] text-content/55 hover:bg-content/10 hover:text-content" onClick={() => void answer({ confirmed: false })}>
              No
            </button>
          ) : null}
          <button type="submit" disabled={!ready || pending} className="h-6 rounded-md bg-content px-2.5 text-[11px] font-medium text-background-base hover:bg-content/80 disabled:opacity-40">
            {dialog.method === "confirm" ? "Confirm" : "Continue"}
          </button>
        </div>
      </form>
    </div>
  );
}
