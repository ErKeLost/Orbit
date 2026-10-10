import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { invoke } from "./native";
import { persistState } from "./persistent";

/**
 * Holding the pairing connection across a backgrounded app.
 *
 * The phone's socket to the desktop is a `WebSocket` inside the WebView, and a
 * backgrounded app loses it twice over: the activity pauses the WebView and its
 * JavaScript timers, and Doze closes what is left. Android has exactly one
 * mechanism that keeps a process out of both — a foreground service — and it
 * requires a notification the user cannot dismiss, which is why this is a
 * setting rather than the default.
 *
 * What it buys is that the socket does not have to be rebuilt: events that
 * happen while the app is away are already in the transcript when it comes back,
 * rather than being re-fetched afterwards. What it does not buy, and cannot, is
 * immunity to a network change or to the desktop going to sleep.
 */

const INTENT_KEY = "orbit.background.connection";

export type BackgroundConnectionStatus = { running: boolean; supported: boolean; error: string | null };

/** Whether the user has asked for this. Restored on launch, like the Host's own intent. */
export function backgroundConnectionWanted(): boolean {
  return localStorage.getItem(INTENT_KEY) === "true";
}

export async function backgroundConnectionStatus(): Promise<BackgroundConnectionStatus> {
  return invoke<BackgroundConnectionStatus>("background_connection_status");
}

/**
 * Start or stop the service, and remember the intent.
 *
 * The intent is written only after the service reports back, so a refusal (a
 * missing prerequisite permission, a start from the background) leaves the
 * setting off rather than promising something on the next launch too.
 */
export async function setBackgroundConnection(enabled: boolean): Promise<BackgroundConnectionStatus> {
  // The service runs either way, but without this Android has nothing it is
  // allowed to show: a foreground service the user cannot see is the silent
  // state this whole setting exists to avoid.
  if (enabled) await ensureNotificationPermission();
  const status = await invoke<BackgroundConnectionStatus>("set_background_connection", { enabled });
  const wanted = enabled && status.running;
  localStorage.setItem(INTENT_KEY, String(wanted));
  persistState(INTENT_KEY, String(wanted));
  return status;
}

/** Ask once, and never let a refusal block the toggle. */
async function ensureNotificationPermission(): Promise<boolean> {
  try {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  } catch {
    return false;
  }
}

/**
 * Re-apply the remembered intent.
 *
 * Called when the mobile shell mounts, which is always with the app in the
 * foreground — the only state Android allows a foreground service to be started
 * from. A refusal is returned rather than thrown: failing to restore is not a
 * reason to keep the app from opening.
 */
export async function restoreBackgroundConnection(): Promise<BackgroundConnectionStatus | null> {
  if (!backgroundConnectionWanted()) return null;
  try {
    const status = await backgroundConnectionStatus();
    if (status.running || !status.supported) return status;
    return await setBackgroundConnection(true);
  } catch {
    return null;
  }
}
