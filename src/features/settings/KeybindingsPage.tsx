import { useEffect, useMemo, useRef, useState } from "react";
import {
  currentKeybindings,
  filterKeybindings,
  loadKeybindingOverrides,
  saveKeybindingOverride,
  shortcutFromKeyEvent,
  subscribeKeybindings,
  type KeybindingOverride,
  type KeybindingView,
} from "../../lib/keybindings";
import { Group } from "../../shared/ui/controls";
import { RotateCcw, Search } from "../../shared/ui/icons";

type Modifier = "metaKey" | "ctrlKey" | "altKey" | "shiftKey";

function modifierOf(event: KeyboardEvent): Modifier | null {
  if (event.key === "Meta" || event.code.startsWith("Meta")) return "metaKey";
  if (event.key === "Control" || event.code.startsWith("Control")) return "ctrlKey";
  if (event.key === "Alt" || event.code.startsWith("Alt")) return "altKey";
  if (event.key === "Shift" || event.code.startsWith("Shift")) return "shiftKey";
  return null;
}

/** 点一下开始录制，按下组合键即保存（MonoCode `ShortcutEditor` 的做法）。 */
function ShortcutRecorder({ row }: { row: KeybindingView }) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const held = useRef<Record<Modifier, boolean>>({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false });

  const apply = (override: KeybindingOverride) => {
    setRecording(false);
    try {
      saveKeybindingOverride(row.command, override);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const bare = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
      if (bare && (event.code === "Escape" || event.code === "Tab")) { setRecording(false); setError(null); return; }
      // 单独的 Delete/Backspace 取消绑定。
      if (bare && (event.code === "Backspace" || event.code === "Delete")) { apply({ disabled: true }); return; }
      const modifier = modifierOf(event);
      if (modifier) { held.current[modifier] = true; return; }
      const next = shortcutFromKeyEvent({
        code: event.code,
        metaKey: event.metaKey || held.current.metaKey,
        ctrlKey: event.ctrlKey || held.current.ctrlKey,
        altKey: event.altKey || held.current.altKey,
        shiftKey: event.shiftKey || held.current.shiftKey,
      });
      apply({ shortcut: next });
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const modifier = modifierOf(event);
      if (modifier) held.current[modifier] = false;
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, row.command]);

  return (
    <div className="relative flex shrink-0 items-center gap-1">
      <button
        type="button"
        aria-label={`修改「${row.label}」快捷键`}
        data-shortcut-recorder={recording ? "true" : undefined}
        onClick={() => {
          held.current = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
          setError(null);
          setRecording(true);
        }}
        className={`h-6 min-w-24 rounded-md border px-2 font-mono text-[11px] leading-none transition-colors ${
          recording
            ? "border-accent text-content"
            : row.disabled
              ? "border-dashed border-content/15 text-content/35"
              : "border-content/15 text-content/75 hover:bg-content/8"
        }`}
      >
        {recording ? "按下组合键…" : row.keys}
      </button>
      {row.modified ? (
        <button
          type="button"
          aria-label={`恢复「${row.label}」默认快捷键`}
          onClick={() => apply({})}
          className="rounded-md p-1 text-content/35 hover:bg-content/10 hover:text-content"
        >
          <RotateCcw className="size-3.5" strokeWidth={1.75} />
        </button>
      ) : null}
      {error ? (
        <p role="alert" className="absolute right-0 top-full z-40 mt-1 w-max max-w-64 rounded-md border border-content/10 bg-background-base/95 px-2 py-1 text-[11px] text-red-400 shadow-lg">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function KeybindingsPage() {
  const [overrides, setOverrides] = useState(loadKeybindingOverrides);
  const [query, setQuery] = useState("");
  useEffect(() => subscribeKeybindings(() => setOverrides(loadKeybindingOverrides())), []);
  const rows = useMemo(() => filterKeybindings(currentKeybindings(), query), [query, overrides]);

  return (
    <Group
      title="快捷键"
      description="点一下快捷键就能录制新组合；录制时按 Delete 取消绑定，Esc 取消。"
      action={
        <div className="flex items-center gap-3">
          <span className="shrink-0 text-[12px] tabular-nums text-content/40">{rows.length} 项</span>
          <label className="flex h-7 w-44 shrink-0 items-center gap-2 rounded-md border border-content/10 px-2 text-content/45 focus-within:border-content/20">
            <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="筛选"
              aria-label="筛选快捷键"
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/35"
            />
          </label>
        </div>
      }
    >
      <div className="flex items-center border-b border-stroke bg-content/5 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-content/40">
        <span className="min-w-0 flex-1">命令</span>
        <span className="w-44 shrink-0">快捷键</span>
        <span className="w-32 shrink-0">生效场景</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-[12px] text-content/45">没有匹配的快捷键</p>
      ) : (
        rows.map((row) => (
          <div key={row.command} className="flex h-11 items-center border-b border-content/5 px-4 text-[12px] last:border-b-0">
            <span className={`min-w-0 flex-1 truncate ${row.disabled ? "text-content/45" : ""}`}>{row.label}</span>
            <div className="w-44 shrink-0">
              <ShortcutRecorder row={row} />
            </div>
            <span className="w-32 shrink-0 truncate text-content/45">{row.when}</span>
          </div>
        ))
      )}
    </Group>
  );
}
