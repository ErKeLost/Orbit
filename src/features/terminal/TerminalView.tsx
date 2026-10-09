import { useEffect, useRef } from "react";
import { invoke } from "../../lib/native";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useAppearance } from "../../lib/appearance";

type PtyData = { id: string; data: string };
type PtyExit = { id: string; code: number | null };

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Orbit's palettes (`features/terminal/ui/TerminalView.tsx`). */
const ANSI_DARK = {
  black: "#1d2428",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#e8eef2",
  brightBlack: "#64748b",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde68a",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#f8fafc",
};

const ANSI_LIGHT = {
  black: "#383a42",
  red: "#e45649",
  green: "#50a14f",
  yellow: "#c18401",
  blue: "#4078f2",
  magenta: "#a626a4",
  cyan: "#0184bc",
  white: "#fafafa",
  brightBlack: "#7c8591",
  brightRed: "#df6b60",
  brightGreen: "#68b567",
  brightYellow: "#d19a2f",
  brightBlue: "#5c89f5",
  brightMagenta: "#b54bb3",
  brightCyan: "#1f9cc9",
  brightWhite: "#ffffff",
};

function cssColor(expr: string, fallback: string): string {
  const probe = document.createElement("span");
  probe.style.color = expr;
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color || fallback;
}

/** xterm cannot parse `var(--x)` in `fontFamily`; resolve it first. */
function terminalFont(): string {
  const fromCss = getComputedStyle(document.documentElement).getPropertyValue("--font-terminal").trim();
  return fromCss || "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace";
}

function terminalTheme(light: boolean) {
  return {
    background: "#00000000",
    foreground: cssColor("var(--color-content)", light ? "#2e2e2e" : "#e8eef2"),
    cursor: cssColor("var(--color-accent)", light ? "#4078f2" : "#4da3f5"),
    cursorAccent: light ? "#ffffff" : "#000000",
    selectionBackground: light ? "rgba(0,0,0,0.18)" : "rgba(255,255,255,0.18)",
    selectionInactiveBackground: light ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.08)",
    ...(light ? ANSI_LIGHT : ANSI_DARK),
  };
}

/**
 * One xterm.js surface bound to one Rust PTY, configured exactly like
 * Orbit's: transparent canvas, resolved Nerd Font stack, bar cursor, and
 * base64 chunks from `pty-data` decoded before they reach the parser.
 */
export function TerminalView({ id, cwd, active }: { id: string; cwd: string; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const scheme = useAppearance((state) => state.scheme);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const light = document.documentElement.classList.contains("theme-light");
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: terminalFont(),
      fontSize: 13,
      lineHeight: 1,
      letterSpacing: 0,
      scrollback: 5000,
      allowTransparency: true,
      smoothScrollDuration: 0,
      theme: terminalTheme(light),
      macOptionIsMeta: IS_MAC,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(element);
    term.current = terminal;
    fit.current = fitAddon;

    const syncSize = () => {
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      void invoke("pty_resize", { id, cols: terminal.cols, rows: terminal.rows }).catch(() => undefined);
    };

    // ⌘/Ctrl+C copies the selection; ⌘/Ctrl+V pastes.
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "c" && terminal.hasSelection()) {
        void navigator.clipboard.writeText(terminal.getSelection());
        return false;
      }
      if (mod && event.key.toLowerCase() === "v") {
        void navigator.clipboard.readText().then((text) => {
          if (text) terminal.paste(text);
        }).catch(() => undefined);
        return false;
      }
      return true;
    });

    const dataListener = terminal.onData((data) => {
      void invoke("pty_write", { id, data }).catch(() => undefined);
    });
    const offs = [
      listen<PtyData>("pty-data", (event) => {
        if (event.payload.id !== id) return;
        // Rust sends base64: PTY output is bytes, not a UTF-8 string.
        try {
          const binary = atob(event.payload.data);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
          terminal.write(bytes);
        } catch {
          terminal.write(event.payload.data);
        }
      }),
      listen<PtyExit>("pty-exit", (event) => {
        if (event.payload.id !== id) return;
        const code = event.payload.code;
        terminal.writeln(`\r\n[进程已退出${code == null ? "" : `，代码 ${code}`}]`);
      }),
    ];

    const observer = new ResizeObserver(() => syncSize());
    observer.observe(element);
    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
      } catch {
        /* zero-sized host during mount */
      }
      void invoke("pty_spawn", { id, cwd, cols: terminal.cols, rows: terminal.rows })
        .then(() => terminal.focus())
        .catch((error: unknown) => terminal.writeln(`\x1b[31m无法启动终端：${String(error)}\x1b[0m`));
    });

    return () => {
      observer.disconnect();
      dataListener.dispose();
      for (const off of offs) void off.then((dispose) => dispose());
      void invoke("pty_kill", { id }).catch(() => undefined);
      terminal.dispose();
      term.current = null;
      fit.current = null;
    };
  }, [cwd, id]);

  // Theme changes re-tint the canvas without restarting the shell.
  useEffect(() => {
    const terminal = term.current;
    if (!terminal) return;
    terminal.options.theme = terminalTheme(scheme === "light");
  }, [scheme]);

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      try {
        fit.current?.fit();
      } catch {
        /* hidden pane */
      }
      term.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return <div ref={host} className="orbit-terminal h-full w-full min-w-0" />;
}
