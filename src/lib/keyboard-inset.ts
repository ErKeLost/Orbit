/**
 * The on-screen keyboard, as a CSS variable.
 *
 * An Android WebView is not resized when the keyboard appears: the activity
 * draws edge-to-edge (`MainActivity.enableEdgeToEdge`) and Android 15+ no
 * longer resizes the window for the IME either. A `100%`-tall shell therefore
 * keeps its full height and the composer ends up *under* the keyboard, which is
 * the bug this pair of fixes exists for.
 *
 * `MainActivity` pads the WebView's parent by the IME inset, and that is the
 * primary fix. This module is the fallback for a shell that resizes the visual
 * viewport instead (the `?preview=mobile` browser preview, iOS) and for the case
 * where the parent cannot be padded. The two agree by construction: when the
 * shell *is* resized, the layout viewport shrinks with it and the inset computed
 * below is 0, so nothing is ever padded twice.
 */

/** Ignore smaller deltas: browser chrome, not a keyboard. */
export const MIN_KEYBOARD_INSET = 60;

/** The custom property the composer dock reads. */
export const KEYBOARD_INSET_VAR = "--keyboard-inset";

/** The one property this module needs from a document element's style. */
export type InsetStyle = {
  getPropertyValue(name: string): string;
  setProperty(name: string, value: string): void;
};

/** The one thing this module needs from a viewport or window. */
export type InsetTarget = {
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
};

export type ViewportMetrics = {
  /** `window.innerHeight` — the layout viewport. */
  innerHeight: number;
  /** `visualViewport.height` — what the keyboard left visible. */
  viewportHeight: number;
  /** `visualViewport.offsetTop` — non-zero while the page is panned. */
  viewportOffsetTop: number;
};

export type KeyboardInsetDeps = {
  /** Where the inset is published. Defaults to `document.documentElement.style`. */
  style?: InsetStyle;
  /** Resizes when the keyboard appears. Defaults to `window.visualViewport`. */
  viewport?: InsetTarget | null;
  /** Also watched, for the resize that is not the visual viewport. Defaults to `window`. */
  window?: InsetTarget | null;
  /** Read fresh metrics on every event. Defaults to the live viewport. */
  metrics?: () => ViewportMetrics;
};

/** Written to only while a real document exists; nothing is ever read back. */
const NOOP_STYLE: InsetStyle = { getPropertyValue: () => "", setProperty: () => {} };

/**
 * How much of the layout viewport the keyboard covers, in CSS pixels.
 *
 * Zero when nothing shrank, when the delta is under `MIN_KEYBOARD_INSET`, and
 * for the non-finite metrics a detached or mid-teardown viewport reports.
 */
export function keyboardInset({ innerHeight, viewportHeight, viewportOffsetTop }: ViewportMetrics): number {
  if (!Number.isFinite(innerHeight) || !Number.isFinite(viewportHeight) || !Number.isFinite(viewportOffsetTop)) return 0;
  const covered = innerHeight - viewportHeight - viewportOffsetTop;
  if (!Number.isFinite(covered) || covered < MIN_KEYBOARD_INSET) return 0;
  return Math.round(covered);
}

/** Publish the inset. Written as `0px` rather than removed, so `max()` reads it. */
export function applyKeyboardInset(inset: number, style: InsetStyle = documentElementStyle()): void {
  const value = inset > 0 ? `${inset}px` : "0px";
  if (style.getPropertyValue(KEYBOARD_INSET_VAR) === value) return;
  style.setProperty(KEYBOARD_INSET_VAR, value);
}

/**
 * Follow the viewport until the returned function is called. The inset is
 * published once immediately, so a shell that mounts with the keyboard already
 * open is not wrong until the next resize.
 */
export function observeKeyboardInset(deps: KeyboardInsetDeps = {}): () => void {
  const style = deps.style ?? documentElementStyle();
  const viewport = deps.viewport === undefined ? windowVisualViewport() : deps.viewport;
  const host = deps.window === undefined ? windowTarget() : deps.window;
  const metrics = deps.metrics ?? readViewport;
  const update = () => applyKeyboardInset(keyboardInset(metrics()), style);

  update();
  viewport?.addEventListener("resize", update);
  viewport?.addEventListener("scroll", update);
  host?.addEventListener("resize", update);

  return () => {
    viewport?.removeEventListener("resize", update);
    viewport?.removeEventListener("scroll", update);
    host?.removeEventListener("resize", update);
    applyKeyboardInset(0, style);
  };
}

function documentElementStyle(): InsetStyle {
  return typeof document === "undefined" ? NOOP_STYLE : document.documentElement.style;
}

function windowTarget(): InsetTarget | null {
  return typeof window === "undefined" ? null : window;
}

function windowVisualViewport(): InsetTarget | null {
  return typeof window === "undefined" ? null : window.visualViewport;
}

function readViewport(): ViewportMetrics {
  if (typeof window === "undefined") return { innerHeight: 0, viewportHeight: 0, viewportOffsetTop: 0 };
  const viewport = window.visualViewport;
  return {
    innerHeight: window.innerHeight,
    viewportHeight: viewport?.height ?? window.innerHeight,
    viewportOffsetTop: viewport?.offsetTop ?? 0,
  };
}
