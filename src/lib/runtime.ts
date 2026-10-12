import { isTauri } from "@tauri-apps/api/core";
import { useWorkspace } from "./store";

/**
 * Runtime detection and cross-cutting UI helpers. Kept separate from the RPC
 * engine so every module can ask “which machine is this?” without importing it.
 */
export const native=isTauri()
export function mobileRuntime(){return useWorkspace.getState().runtimeTarget==='mobile'}
export function desktopRuntime(){return useWorkspace.getState().runtimeTarget==='desktop'}
/**
 * Any runtime with a workspace backend.
 *
 * The desktop itself, or a phone whose paired desktop answers (`native.ts`
 * routes the command over the authenticated socket), so a capability no longer
 * depends on which machine the UI happens to be running on. Only the browser
 * preview has nothing behind it.
 */
export function workspaceBackend(){const target=useWorkspace.getState().runtimeTarget;return target==='desktop'||target==='mobile'}
export function report(error:unknown){useWorkspace.getState().set({error:String(error instanceof Error?error.message:error)})}
