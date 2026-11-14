/** Matches the composer's `max-h-40`, so the field stops growing where it clips. */
export const COMPOSER_MAX_HEIGHT = 160;

type Resizable = {
  style: { height: string };
  scrollHeight: number;
  parentElement?: {
    style: { minHeight: string };
    offsetHeight: number;
  } | null;
};

/**
 * Grow the field to its content.
 *
 * Measuring at `height: auto` collapses the field for one forced layout. The
 * transcript above is a flex sibling, so that collapse grows its viewport and
 * the browser clamps `scrollTop`. Restoring the height does not restore the
 * clamp. Stick-to-bottom then pins back, and a turn whose `content-visibility`
 * estimate just changed size pins again — the chat shakes on every keystroke.
 * Hold the wrapper's current height until the final value is written so the
 * transcript never sees the temporary viewport.
 */
export function resizeComposer(el: Resizable, maxHeight = COMPOSER_MAX_HEIGHT) {
  if (el.scrollHeight === 0) return;
  const wrapper = el.parentElement;
  const minHeight = wrapper?.style.minHeight ?? "";
  // A hidden field reports 0. Writing that in would collapse a draft that
  // has not been laid out yet (a session panel behind `display: none`).
  if (wrapper && wrapper.offsetHeight === 0) return;
  if (wrapper) wrapper.style.minHeight = `${wrapper.offsetHeight}px`;
  try {
    const previous = el.style.height;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, maxHeight);
    const previousPx = Number.parseFloat(previous);
    // WebKit's scrollHeight wobbles by a pixel between identical drafts.
    // Publishing that wobble resizes the transcript on every key.
    if (Number.isFinite(previousPx) && Math.abs(previousPx - next) <= 1) {
      el.style.height = previous;
      return;
    }
    el.style.height = `${next}px`;
  } finally {
    if (wrapper) wrapper.style.minHeight = minHeight;
  }
}
