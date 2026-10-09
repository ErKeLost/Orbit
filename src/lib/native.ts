import { invoke as tauriInvoke } from "@tauri-apps/api/core"
import { runRemoteInvoke } from "./remote-runtime"
import { remoteCanInvoke } from "./remote-workspace"
import { useWorkspace } from "./store"

/**
 * `invoke`, routed to the machine that owns the answer.
 *
 * The phone runs the same React application as the desktop, so its components
 * ask the same questions — list this directory, read this file, stage this
 * change. On the desktop those questions go to the local backend; on a paired
 * phone they travel to the desktop over the same authenticated, encrypted
 * socket the transcript uses (`host.invoke`) and are answered by the same Rust
 * functions. Nothing in the UI has to know which machine it is running on,
 * which is the whole point of one application in two shells.
 *
 * Two rules keep the choice honest:
 *
 * * **The Host decides.** A command is sent to the desktop only when that
 *   desktop advertised it. There is no second allowlist here to drift out of
 *   step with `src-tauri/src/remote_ops.rs`, and a command the Host will not
 *   answer is not sent at all — an older phone against a newer desktop simply
 *   keeps using what it knows.
 * * **Before the first snapshot, calls stay local.** Bootstrap commands
 *   (`runtime_environment`, the mobile update probe) are about *this* device,
 *   and answering them from the other machine would be worse than answering
 *   them late.
 *
 * A command the desktop never advertised falls through to the local backend,
 * which is the truthful answer for a device that does not have it.
 */
export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (useWorkspace.getState().runtimeTarget === "mobile" && remoteCanInvoke(command)) {
    return runRemoteInvoke<T>(command, args)
  }
  return tauriInvoke<T>(command, args)
}
