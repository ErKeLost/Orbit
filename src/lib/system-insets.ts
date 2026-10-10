/**
 * The system bars, as CSS variables.
 *
 * `env(safe-area-inset-top)` is **not** the status bar on Android: Chromium
 * maps it to the display *cutout*, so a phone whose camera is not a cutout (or
 * whose cutout is not on the top edge) reports `0`. The 44px mobile title bar
 * then sits under the clock, where the system keeps the touches — the drawer
 * button and the session title become unreachable. Android's own
 * `WindowInsetsCompat` are the honest numbers, so `MainActivity` publishes them
 * here and `--safe-top` / `--safe-bottom` take whichever is larger.
 *
 * Two paths, because either one alone has a hole: the page pulls once on mount
 * (`window.orbitNative.insets()`), which never races the first layout, and every
 * later change is pushed through `window.__orbitInsets` — rotation, the status
 * bar hiding, a different nav mode.
 */

/** Written to only while a real document exists; nothing is ever read back. */
export type InsetStyle = {
  getPropertyValue(name: string): string;
  setProperty(name: string, value: string): void;
};

/** The push bridge `MainActivity` calls. */
export const INSETS_GLOBAL = "__orbitInsets";

/** The pull bridge (`addJavascriptInterface`). */
export const INSETS_INTERFACE = "orbitNative";

/** The custom properties the shells read. */
export const SYSTEM_INSET_TOP_VAR = "--android-inset-top";
export const SYSTEM_INSET_BOTTOM_VAR = "--android-inset-bottom";

export type SystemBarInsets = { top: number; bottom: number };

/**
 * Read the native answer — `"top,bottom"`, already in CSS pixels.
 *
 * Anything unparseable is "no answer" rather than a guess: a wrong inset moves
 * the title bar somewhere the user cannot press either.
 */
export function parseSystemBarInsets(value: string | null | undefined): SystemBarInsets | null {
  if (typeof value !== "string") return null;
  const parts = value.split(",");
  if (parts.length !== 2) return null;
  const top = Number(parts[0]!.trim());
  const bottom = Number(parts[1]!.trim());
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return null;
  return { top: Math.max(0, Math.round(top)), bottom: Math.max(0, Math.round(bottom)) };
}

/** Publish the insets. Written as `0px` rather than removed, so `max()` reads it. */
export function applySystemBarInsets(insets: SystemBarInsets, style: InsetStyle = documentElementStyle()): void {
  write(style, SYSTEM_INSET_TOP_VAR, insets.top);
  write(style, SYSTEM_INSET_BOTTOM_VAR, insets.bottom);
}

function write(style: InsetStyle, name: string, value: number): void {
  const next = `${value}px`;
  if (style.getPropertyValue(name) === next) return;
  style.setProperty(name, next);
}

export type SystemInsetDeps = {
  /** Where the insets are published. Defaults to `document.documentElement.style`. */
  style?: InsetStyle;
  /** The `window` the bridges are installed on. */
  host?: SystemInsetHost | null;
  /** The native interface, pulled on mount. Defaults to `window.orbitNative`. */
  native?: { insets?: () => string } | null;
  /** Re-pull on the events that change the bars. Defaults to `window`. */
  events?: EventTarget | null;
};

/** `window`, plus whatever global `MainActivity` installs on it. */
export type SystemInsetHost = Record<string, unknown> & {
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

/**
 * Follow the system bars until the returned function is called.
 *
 * The push handler is installed before the first pull, so a push that lands
 * while the pull is in flight cannot be lost. A pull that answers nothing
 * leaves the variables alone — `env()` is still there as the floor.
 */
export function observeSystemBarInsets(deps: SystemInsetDeps = {}): () => void {
  const style = deps.style ?? documentElementStyle();
  const host = deps.host === undefined ? windowHost() : deps.host;
  const native = deps.native === undefined ? nativeBridge() : deps.native;
  const events = deps.events === undefined ? windowEvents() : deps.events;

  const pull = () => {
    let answer: string | null | undefined;
    try {
      answer = native?.insets?.();
    } catch {
      // A bridge that throws is the same as one that is not there.
      answer = null;
    }
    const insets = parseSystemBarInsets(answer);
    if (insets) applySystemBarInsets(insets, style);
  };

  // A push is authoritative: it is the same numbers, at the moment they change
  // (the keyboard sliding in and out is the common one). A push arriving before
  // this mounts is covered by the pull below.
  const push = (top: unknown, bottom: unknown) => {
    const insets = parseSystemBarInsets(`${Number(top)},${Number(bottom)}`);
    if (insets) applySystemBarInsets(insets, style);
  };
  if (host) host[INSETS_GLOBAL] = push;

  pull();
  events?.addEventListener("resize", pull);
  events?.addEventListener("orientationchange", pull);

  return () => {
    events?.removeEventListener("resize", pull);
    events?.removeEventListener("orientationchange", pull);
    if (host && host[INSETS_GLOBAL] === push) delete host[INSETS_GLOBAL];
  };
}

function documentElementStyle(): InsetStyle {
  return typeof document === "undefined" ? { getPropertyValue: () => "", setProperty: () => {} } : document.documentElement.style;
}

function windowHost(): SystemInsetHost | null {
  return typeof window === "undefined" ? null : (window as unknown as SystemInsetHost);
}

function windowEvents(): EventTarget | null {
  return typeof window === "undefined" ? null : window;
}

function nativeBridge(): { insets?: () => string } | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { [INSETS_INTERFACE]?: { insets?: () => string } })[INSETS_INTERFACE] ?? null;
}
