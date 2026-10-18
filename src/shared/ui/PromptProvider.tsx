import { useMemo, useState, type ReactNode } from "react";
import { PromptContext, type PromptOptions } from "../../lib/prompt";
import { Modal } from "./Modal";
import { Input, TextArea } from "./controls";

/** Hosts `usePrompt()`: a title, one field, and Orbit's confirm/cancel pair. */
export function PromptProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<(PromptOptions & { resolve: (value: string | null) => void }) | null>(null);
  const [value, setValue] = useState("");
  const close = (next: string | null) => {
    request?.resolve(next);
    setRequest(null);
  };
  const prompt = useMemo(
    () => (options: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        setValue(options.initial ?? "");
        setRequest({ ...options, resolve });
      }),
    [],
  );
  return (
    <PromptContext.Provider value={prompt}>
      {children}
      {request ? (
        <Modal title={request.title} size={request.multiline ? "md" : "sm"} onClose={() => close(null)}>
          <form
            className="flex flex-col gap-3.5 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              close(value);
            }}
          >
            {request.multiline ? (
              <TextArea autoFocus rows={8} value={value} onChange={(event) => setValue(event.target.value)} className="font-mono" />
            ) : (
              <Input autoFocus value={value} onChange={(event) => setValue(event.target.value)} />
            )}
            <div className="flex justify-end gap-2 text-[13px]">
              <button type="button" onClick={() => close(null)} className="rounded-md px-3 py-1.5 hover:bg-content/8 active:scale-[0.97]">
                取消
              </button>
              <button type="submit" className="rounded-md bg-content px-3 py-1.5 font-medium text-background-base hover:bg-content/80 active:scale-[0.97]">
                确认
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </PromptContext.Provider>
  );
}
