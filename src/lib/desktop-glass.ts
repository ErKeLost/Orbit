import { invoke } from "./native";

/**
 * The desktop behind the window, painted by the page.
 *
 * `window_glass.rs` explains why this is not a transparent window: the app
 * renders in CEF's windowed mode, where Chromium's own fill is opaque by
 * contract, so the vibrancy view the shell used to install under the page was
 * never visible. Instead the shell captures what is behind the window and this
 * module paints it into `.desktop-glass-layer` — a full-viewport layer *under*
 * the page content, carrying the theme colour as its own background so a sample
 * that has not arrived yet still looks like the window it replaces.
 *
 * The layer is created and dropped with the glass toggle; the image inside it is
 * refreshed on move, resize, focus and when the window becomes visible again,
 * because the desktop behind a window that moved is a different picture.
 */

type Sample = { data: string; width: number; height: number };

export type DesktopSampleState = {
  /** A sample has been painted at least once this run. */
  ready: boolean;
  /** Why the last capture failed, when it did. */
  error: string | null;
  /** Wall clock of the last successful capture. */
  at: number;
  /**
   * The shell has no sampling: its page is genuinely see-through and the system
   * blurs the desktop behind it (the `glass-wry` build). Nothing to paint here.
   */
  unsupported: boolean;
};

/** Two captures closer than this are the same picture; a drag must not queue. */
const MIN_INTERVAL_MS = 220;
/** Wait for the window to stop moving before grabbing again. */
const SETTLE_MS = 140;

let layer: HTMLDivElement | null = null;
let imageUrl: string | null = null;
let enabled = false;
let installed = false;
/** This shell paints the desktop itself with a native material (see above). */
let unsupported = false;
let running = false;
let dirty = false;
let lastCaptureAt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

let state: DesktopSampleState = { ready: false, error: null, at: 0, unsupported: false };
const listeners = new Set<() => void>();

function publish(patch: Partial<DesktopSampleState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function desktopSampleState(): DesktopSampleState {
  return state;
}

export function subscribeDesktopSample(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function ensureLayer(): HTMLDivElement | null {
  if (typeof document === "undefined" || !document.body) return null;
  if (layer?.isConnected) return layer;
  const node = document.createElement("div");
  node.className = "desktop-glass-layer";
  // Decoration only: it sits under the app, so it must never take a click.
  node.setAttribute("aria-hidden", "true");
  document.body.prepend(node);
  layer = node;
  if (imageUrl) node.style.backgroundImage = `url("${imageUrl}")`;
  return node;
}

function dropLayer() {
  layer?.remove();
  layer = null;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function decode(base64: string): Promise<string> {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
  // Decode before swapping, so the layer never goes blank between two samples.
  return new Promise<string>((resolve) => {
    const image = new Image();
    image.onload = () => resolve(url);
    image.onerror = () => resolve(url);
    image.src = url;
  });
}

async function captureOnce() {
  lastCaptureAt = performance.now();
  try {
    const sample = await invoke<Sample | null>("glass_desktop_sample");
    if (!enabled) return;
    if (!sample) {
      // The window's own page is transparent in this build; a sample layer here
      // would paint an opaque sheet over the very thing the glass is made of.
      unsupported = true;
      dropLayer();
      document.documentElement.classList.remove("has-desktop-sample");
      publish({ ready: false, error: null, unsupported: true });
      return;
    }
    const node = ensureLayer();
    if (!node) return;
    const url = await decode(sample.data);
    const previous = imageUrl;
    imageUrl = url;
    node.style.backgroundImage = `url("${url}")`;
    document.documentElement.classList.add("has-desktop-sample");
    if (previous) setTimeout(() => URL.revokeObjectURL(previous), 1000);
    publish({ ready: true, error: null, at: Date.now() });
  } catch (error) {
    document.documentElement.classList.remove("has-desktop-sample");
    // The layer keeps painting the theme colour, which is what the window looks
    // like without glass — never a hole through to Chromium's white.
    publish({ error: error instanceof Error ? error.message : String(error) });
  }
}

async function drain(): Promise<void> {
  if (running) {
    dirty = true;
    return;
  }
  running = true;
  try {
    do {
      dirty = false;
      const wait = lastCaptureAt + MIN_INTERVAL_MS - performance.now();
      if (wait > 0) await sleep(wait);
      if (!enabled) return;
      await captureOnce();
    } while (dirty && enabled);
  } finally {
    running = false;
  }
}

/** Ask for a fresh picture of the desktop behind the window. */
export function requestDesktopSample(delay = SETTLE_MS): void {
  if (!enabled || unsupported) return;
  if (timer != null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void drain();
  }, Math.max(0, delay));
}

export function setDesktopGlassEnabled(on: boolean): void {
  // Appearance state changes on every slider move; only the toggle itself (and
  // a failed first capture) should cost a capture. The window's own events
  // handle everything else.
  if (on === enabled) return;
  enabled = on;
  if (!on) {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    dropLayer();
    document.documentElement.classList.remove("has-desktop-sample");
    return;
  }
  // A build without sampling never gets a layer: its page is already see-through.
  if (unsupported) {
    requestDesktopSample(0);
    return;
  }
  if (!ensureLayer()) return;
  // A previous run's picture is still valid until the new one lands, so the
  // toggle does not go solid for a frame.
  if (imageUrl) document.documentElement.classList.add("has-desktop-sample");
  requestDesktopSample(0);
}

/**
 * Follow the window. Its events are the only thing that invalidates a sample:
 * the desktop does not move under a still window.
 */
export async function installDesktopGlass(): Promise<void> {
  if (installed) return;
  installed = true;
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) requestDesktopSample(400);
    });
  }
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const window = getCurrentWindow();
    const moved = () => requestDesktopSample();
    const refocused = ({ payload }: { payload: boolean }) => {
      if (payload) requestDesktopSample(260);
    };
    void window.onMoved(moved).catch(() => undefined);
    void window.onResized(moved).catch(() => undefined);
    void window.onScaleChanged(moved).catch(() => undefined);
    void window.onFocusChanged(refocused).catch(() => undefined);
  } catch {
    // Browser preview: there is no window to follow.
  }
}
