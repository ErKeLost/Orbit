import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** 主窗口广播过来的当前范围（`quick_composer.rs` 的 `QUICK_SCOPE_EVENT`）。 */
type ScopeMessage = string;

/** 路径末段当项目名；和主窗口 `projectName` 的读法一致，但这里不值得为它拉一个模块。 */
function projectName(path: string) {
  if (!path) return "";
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).filter(Boolean).at(-1) ?? trimmed;
}

/**
 * 唤起后弹出的那一个输入框。
 *
 * 它刻意做得很小：一个项目标签、一个输入框、两行提示。没有模型选择、没有权限、
 * 没有会话列表——那些都属于主窗口，属于「我在干活」；这里只回答一个问题：
 * 这句话要说什么。
 *
 * 约定：
 * - `Enter` 发送，`Shift+Enter` 换行（和主窗口相反，因为这里默认就是「说完了」）；
 * - `Esc` 收起，不问；
 * - 发出去之后窗口自己消失，主窗口带着结果出现（`quick_send` 做的）。
 */
export function QuickComposer() {
  const [text, setText] = useState("");
  const [cwd, setCwd] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  // 主窗口每次唤起都会广播一次自己的 cwd：小窗不必问 Rust，也不必自己记。
  useEffect(() => {
    const stop = listen<ScopeMessage>("orbit:quick-scope", () => {
      void readScope().then(setCwd);
    });
    void readScope().then(setCwd);
    return () => void stop.then((off) => off());
  }, []);

  useLayoutEffect(() => {
    field.current?.focus();
    // 输入框自己长高：一行话不该被一个固定高度的框框住。
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(96, el.scrollHeight)}px`;
  }, [text]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void invoke("quick_hide");
        setText("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function send() {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    setError(null);
    try {
      await invoke("quick_send", { text: message, cwd });
      setText("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="h-full w-full p-2">
      <div className="flex h-full flex-col overflow-hidden rounded-xl border border-white/10 bg-background-base/95 shadow-[0_24px_60px_rgba(0,0,0,.45)] backdrop-blur-xl">
        <div className="flex h-8 shrink-0 items-center gap-2 px-3 text-[11px] text-content/45">
          <span className="size-1.5 shrink-0 rounded-full bg-accent" />
          <span className="min-w-0 truncate font-medium text-content/70">{projectName(cwd) || "没有项目"}</span>
          <span className="flex-1" />
          <span className="shrink-0">Enter 发送 · Esc 收起</span>
        </div>
        <textarea
          ref={field}
          value={text}
          autoFocus
          rows={1}
          placeholder="说点什么…"
          spellCheck={false}
          aria-label="快速输入"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // 输入法组合中不抢 Enter，否则中文没法选词。
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          className="min-h-9 w-full flex-1 resize-none bg-transparent px-3 pb-2 text-[13px] leading-5 text-content outline-none placeholder:text-content/30"
        />
        <div className="flex h-9 shrink-0 items-center gap-2 border-t border-stroke/60 px-3">
          {error ? (
            <span role="alert" className="min-w-0 flex-1 truncate text-[11px] text-red-300">{error}</span>
          ) : (
            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-content/30">{cwd}</span>
          )}
          <button
            type="button"
            onClick={() => void send()}
            disabled={!text.trim() || sending}
            className="flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-content px-2 text-[11px] font-medium text-background-base disabled:opacity-40"
          >
            {sending ? "发送中" : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 当前范围。两个窗口同源，所以主窗口把 cwd 写进 localStorage 就够了——
 * 比为了一个字符串再开一条命令便宜。
 */
async function readScope(): Promise<string> {
  try {
    return localStorage.getItem("orbit.quickScope") ?? "";
  } catch {
    return "";
  }
}
