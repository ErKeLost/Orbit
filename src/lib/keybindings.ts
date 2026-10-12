/**
 * Keybinding registry for Orbit.
 *
 * One table owns every shortcut's default, its display label and the context it
 * applies in. User rebinds live in localStorage and are applied by `pressed`,
 * so a handler never hard-codes a key again. Modelled on MonoCode's
 * `settings/model/settings.ts`, trimmed to what Orbit actually binds.
 */
export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The platform's primary modifier in canonical form. */
const MOD = IS_MAC ? "Command" : "Control";
const mod = (code: string) => `${MOD}+${code}`;

export type KeybindingRow = {
  /** Stable id, also persisted as the override key. */
  command: string;
  /** Canonical default chord, or "" when unbound by default. */
  default: string;
  /** Human label shown in settings. */
  label: string;
  /** Where it applies, e.g. "Always" / "编辑器聚焦时". */
  when: string;
};

export const KEYBINDINGS: KeybindingRow[] = [
  { command: "App: Settings", default: mod("Comma"), label: "打开设置", when: "Always" },
  { command: "App: Search", default: mod("KeyK"), label: "搜索全部", when: "Always" },
  { command: "App: Quick Open", default: mod("KeyP"), label: "转到文件 / 命令", when: "Always" },
  { command: "App: Find in Files", default: `${MOD}+Shift+KeyF`, label: "全局搜索", when: "Always" },
  { command: "App: Toggle Sidebar", default: mod("KeyB"), label: "切换侧栏", when: "Always" },
  { command: "App: Reload", default: mod("KeyR"), label: "重载界面", when: "Always" },
  { command: "Session: New", default: mod("KeyN"), label: "新建会话", when: "Always" },
  { command: "Session: Save File", default: mod("KeyS"), label: "保存当前文件", when: "编辑器中" },
  { command: "Pane: Close", default: mod("KeyW"), label: "关闭当前面板", when: "Always" },
  { command: "Pane: Close Editors", default: `${MOD}+Shift+KeyW`, label: "关闭全部编辑器面板", when: "Always" },
  { command: "Pane: Split Right", default: mod("KeyD"), label: "向右分屏会话", when: "会话面板聚焦时" },
  { command: "Pane: Split Down", default: `${MOD}+Shift+KeyD`, label: "向下分屏会话", when: "会话面板聚焦时" },
  { command: "Terminal: Toggle", default: mod("KeyJ"), label: "展开 / 收起终端", when: "Always" },
  { command: "Voice: Toggle", default: `${MOD}+Shift+KeyM`, label: "语音输入 开始 / 结束", when: "首页或会话输入框" },
  { command: "Voice: Start", default: "", label: "开始语音输入", when: "首页或会话输入框" },
  { command: "Voice: Stop", default: "", label: "结束语音输入", when: "首页或会话输入框" },
];

export type KeybindingOverride = { disabled?: boolean; shortcut?: string };
export type KeybindingOverrides = Record<string, KeybindingOverride>;

export type ShortcutEvent = Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

const OVERRIDES_KEY = "orbit.keybindings.v1";
const CHANGE_EVENT = "orbit:keybindings-change";

const VALID_COMMANDS = new Set(KEYBINDINGS.map((row) => row.command));
const MODIFIERS = ["Command", "Control", "Alt", "Shift"] as const;

/** Canonical chord for a key event, using `code` so it is layout-independent. */
export function shortcutFromKeyEvent(event: ShortcutEvent): string {
  const parts: string[] = [];
  if (event.metaKey) parts.push("Command");
  if (event.ctrlKey) parts.push("Control");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(event.code);
  return parts.join("+");
}

/** Normalise/validate a stored chord; returns null when it could never fire. */
export function canonicalShortcut(value: string): string | null {
  const parts = value.split("+").filter(Boolean);
  if (parts.length < 2) return null;
  const code = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);
  if (!code || modifiers.some((part) => !(MODIFIERS as readonly string[]).includes(part))) return null;
  // A plain key or Shift-only chord would hijack typing.
  if (!modifiers.some((part) => part === "Command" || part === "Control" || part === "Alt")) return null;
  return [...modifiers, code].join("+");
}

const KEY_LABELS: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Minus: "-",
  Equal: "+",
  Backquote: "`",
  Space: "Space",
  Enter: "↵",
  Escape: "Esc",
  Tab: "Tab",
  Backspace: "⌫",
  Delete: "⌦",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

function codeLabel(code: string) {
  if (KEY_LABELS[code]) return KEY_LABELS[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return code;
}

function modifierToken(modifier: string) {
  switch (modifier) {
    case "Command": return IS_MAC ? "⌘" : "Ctrl";
    case "Control": return IS_MAC ? "⌃" : "Ctrl";
    case "Alt": return IS_MAC ? "⌥" : "Alt";
    case "Shift": return "⇧";
    default: return modifier;
  }
}

export function shortcutTokens(chord: string): string[] {
  if (!chord) return [];
  const parts = chord.split("+");
  return parts.map((part) => (MODIFIERS.includes(part as (typeof MODIFIERS)[number]) ? modifierToken(part) : codeLabel(part)));
}

export function shortcutLabel(chord: string): string {
  return shortcutTokens(chord).join(IS_MAC ? "" : "+");
}

let cacheRaw: string | null = null;
let cacheValue: KeybindingOverrides = {};

export function loadKeybindingOverrides(): KeybindingOverrides {
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY);
    if (raw === cacheRaw) return { ...cacheValue };
    const parsed = raw ? JSON.parse(raw) : {};
    const next: KeybindingOverrides = {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [command, entry] of Object.entries(parsed as Record<string, unknown>)) {
        if (!VALID_COMMANDS.has(command) || !entry || typeof entry !== "object") continue;
        const candidate = entry as { disabled?: unknown; shortcut?: unknown };
        const shortcut = typeof candidate.shortcut === "string" ? canonicalShortcut(candidate.shortcut) : null;
        if (shortcut) next[command] = { shortcut };
        else if (candidate.disabled === true) next[command] = { disabled: true };
      }
    }
    cacheRaw = raw;
    cacheValue = next;
    return { ...next };
  } catch {
    return {};
  }
}

function commit(next: KeybindingOverrides) {
  try {
    if (Object.keys(next).length) localStorage.setItem(OVERRIDES_KEY, JSON.stringify(next));
    else localStorage.removeItem(OVERRIDES_KEY);
  } catch {
    throw new Error("无法保存快捷键");
  }
  cacheRaw = null;
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** The chord a command owns right now: override, else default, else "". */
export function currentShortcut(command: string): string {
  const override = loadKeybindingOverrides()[command];
  if (override?.disabled) return "";
  if (override?.shortcut) return override.shortcut;
  return defaultShortcut(command);
}

export function defaultShortcut(command: string): string {
  return KEYBINDINGS.find((row) => row.command === command)?.default ?? "";
}

/** Reject a chord already owned by another command, so nothing gets shadowed. */
export function validateKeybindingShortcut(command: string, shortcut: string): string {
  const canonical = canonicalShortcut(shortcut);
  if (!canonical) throw new Error("这个组合不能作为快捷键");
  for (const row of KEYBINDINGS) {
    if (row.command === command) continue;
    if (currentShortcut(row.command) === canonical) throw new Error(`已被「${row.label}」占用`);
  }
  return canonical;
}

export function saveKeybindingOverride(command: string, override: KeybindingOverride): KeybindingOverrides {
  if (!VALID_COMMANDS.has(command)) throw new Error("未知命令");
  const next = loadKeybindingOverrides();
  if (override.disabled) next[command] = { disabled: true };
  else if (override.shortcut) next[command] = { shortcut: validateKeybindingShortcut(command, override.shortcut) };
  else delete next[command];
  commit(next);
  return next;
}

/** True when the event fires `command`'s current binding. */
export function pressed(command: string, event: ShortcutEvent): boolean {
  const chord = currentShortcut(command);
  return Boolean(chord) && chord === shortcutFromKeyEvent(event);
}

export type KeybindingView = KeybindingRow & { keys: string; disabled: boolean; modified: boolean };

export function currentKeybindings(): KeybindingView[] {
  const overrides = loadKeybindingOverrides();
  return KEYBINDINGS.map((row) => {
    const override = overrides[row.command];
    const chord = currentShortcut(row.command);
    return {
      ...row,
      keys: chord ? shortcutLabel(chord) : "未绑定",
      disabled: override?.disabled === true,
      modified: Boolean(override),
    };
  });
}

export function filterKeybindings(rows: KeybindingView[], query: string): KeybindingView[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) =>
    row.label.toLowerCase().includes(needle) ||
    row.command.toLowerCase().includes(needle) ||
    row.keys.toLowerCase().includes(needle) ||
    row.when.toLowerCase().includes(needle));
}

export function subscribeKeybindings(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => { if (event.key === OVERRIDES_KEY) onChange(); };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}
