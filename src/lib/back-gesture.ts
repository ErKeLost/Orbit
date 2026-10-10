/**
 * The Android back gesture, decided by whatever the user is looking at.
 *
 * `WryActivity` answers back itself — `canGoBack() ? goBack() : onBackPressed()`
 * — which is the wrong question for a single-page shell: nothing here pushes
 * history, so `canGoBack()` is never true and back means "leave the app". The
 * drawer, the file pane and the screen window never get the press, and a user
 * who taps the wrong session loses the whole app to their thumb. `MainActivity`
 * therefore asks this module instead, and only leaves when nothing claims it.
 *
 * Handlers are a stack rather than a set, and a press walks it from the top:
 * overlays register while they are open, so the newest one is the one on screen,
 * and walking means a handler that is no longer interested declines instead of
 * swallowing the press.
 */

/** Whether a surface took the press. Anything else counts as "not mine". */
export type BackHandler = () => boolean;

/** The global `MainActivity` calls. Its absence is "nothing to handle". */
export const BACK_GLOBAL = "__orbitBack";

const handlers: BackHandler[] = [];

/**
 * Claim back presses until the returned function is called.
 *
 * Registration order is stacking order: an overlay registered later is asked
 * first. Callers register only while their surface is open, which is what keeps
 * that claim true.
 */
export function registerBackHandler(handler: BackHandler): () => void {
  handlers.push(handler);
  return () => {
    const index = handlers.lastIndexOf(handler);
    if (index >= 0) handlers.splice(index, 1);
  };
}

/**
 * Offer a press to the surfaces, newest first. Reports whether anything took it.
 *
 * A handler that throws is treated as uninterested, and the walk continues: a
 * broken overlay must not be able to turn back into a no-op that the user cannot
 * press their way out of. Falling through to the system is exactly what happens
 * when nothing is open, so the failure mode is the ordinary one.
 */
export function handleBackPress(): boolean {
  for (let index = handlers.length - 1; index >= 0; index -= 1) {
    try {
      if (handlers[index]!() === true) return true;
    } catch {
      // Deliberately swallowed; see above.
    }
  }
  return false;
}

/** How many surfaces are currently claiming the gesture. */
export function backHandlerCount(): number {
  return handlers.length;
}

/**
 * Publish `handleBackPress` where native code can reach it.
 *
 * The installed global is a fresh closure rather than `handleBackPress` itself,
 * and that is the whole point: it lets the uninstaller recognise *its own*
 * install, so a mount that is torn down late cannot delete the one a newer mount
 * put there. Returns that uninstaller.
 */
export function installBackGesture(target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): () => void {
  const installed = () => handleBackPress();
  target[BACK_GLOBAL] = installed;
  return () => {
    if (target[BACK_GLOBAL] === installed) delete target[BACK_GLOBAL];
  };
}
