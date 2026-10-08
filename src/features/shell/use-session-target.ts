import { useWorkspace } from "../../lib/store";

/**
 * The connection a control should act on: inside a session pane that is the
 * pane's own connection, otherwise the shell's. `lib/rpc.ts` `route()` accepts
 * a connection id wherever a project path is expected, so this can be passed
 * straight to `sendPrompt` / `stop` / `steerFollowUp` / `recallQueue`.
 */
export function useSessionTarget(): string {
  return useWorkspace((state) => state.connectionId || state.cwd);
}
