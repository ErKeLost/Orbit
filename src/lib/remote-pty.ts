import { emit } from "@tauri-apps/api/event";
import type { RemoteEvent } from "./remote-protocol";

/**
 * Terminal frames, from the pairing socket to the same dock the desktop draws.
 *
 * `TerminalView` listens for the desktop's own events — `pty-data` and
 * `pty-exit` — which on a phone are events of the *phone's* window and therefore
 * never fire. The Host republishes each of them over the socket
 * (`src-tauri/src/pty_term.rs`), and this turns those frames back into local
 * events. The dock keeps one component, one event protocol and no idea which
 * machine it is running on.
 *
 * The desktop never receives these frames — a Host does not connect to itself —
 * so running this there is a no-op rather than a double delivery.
 */

export type PtyLocalEvent =
  | { name: "pty-data"; payload: { id: string; data: string } }
  | { name: "pty-exit"; payload: { id: string; code: number | null } };

/** The local event a forwarded frame stands for, or null if it is not one. */
export function ptyLocalEvent(event: RemoteEvent): PtyLocalEvent | null {
  if (event.type === "pty.event") return { name: "pty-data", payload: { id: event.id, data: event.data } };
  if (event.type === "pty.exit") return { name: "pty-exit", payload: { id: event.id, code: event.code } };
  return null;
}

/**
 * Deliver one forwarded frame to the local event bus.
 *
 * Returns whether the frame was one of ours, so a caller can report "nothing
 * here" without having to know the names. Emission failures are swallowed on
 * purpose: the webview can be tearing down mid-frame, and a dead terminal must
 * not be able to break the socket that also carries the transcript.
 */
export async function deliverPtyEvent(
  event: RemoteEvent,
  send: (name: string, payload: unknown) => Promise<unknown> = emit,
): Promise<boolean> {
  const local = ptyLocalEvent(event);
  if (!local) return false;
  try {
    await send(local.name, local.payload);
  } catch {
    // Nothing to do and nowhere to say it: the next frame finds the window again.
  }
  return true;
}
