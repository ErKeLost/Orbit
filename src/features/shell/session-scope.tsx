import { useMemo, type ReactNode } from "react";
import { SessionScopeContext, workspaceStore, type Workspace, type WorkspaceStore } from "../../lib/store";
import {
  connectionCwd,
  connectionSnapshot,
  patchConnectionSnapshot,
  primeConnectionSnapshot,
  subscribeSnapshot,
} from "../../lib/rpc";

/**
 * A pane that shows a connection the shell is *not* projecting (MonoCode's
 * `TranscriptPool`: every session pane stays live). The facade merges that
 * connection's snapshot over the app state, so the whole chat stack
 * (`useWorkspace(...)`) reads the pane's own session with no call-site changes.
 */

/** Keys that live per connection (mirrors `Snapshot` in lib/rpc.ts). */
const PROJECTION_KEYS = ["telemetry", "transcript", "state", "connection", "error", "draft", "dialogs", "notices", "statuses", "widgets", "agents"] as const;

const facades = new Map<string, WorkspaceStore>();

function merge(connectionId: string): Workspace {
  const global = workspaceStore.getState();
  const snapshot = connectionSnapshot(connectionId);
  if (!snapshot) return global;
  return {
    ...global,
    ...snapshot,
    connectionId,
    cwd: connectionCwd(connectionId) ?? global.cwd,
  };
}

/** A zustand-shaped store over one connection's snapshot. */
function sessionStore(connectionId: string): WorkspaceStore {
  const cached = facades.get(connectionId);
  if (cached) return cached;
  primeConnectionSnapshot(connectionId);
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  subscribeSnapshot(connectionId, emit);
  const facade: WorkspaceStore = {
    getState: () => merge(connectionId),
    getInitialState: () => merge(connectionId),
    setState: (partial) => {
      const next = typeof partial === "function" ? partial(merge(connectionId)) : partial;
      const projection: Record<string, unknown> = {};
      const rest: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(next as Record<string, unknown>)) {
        if ((PROJECTION_KEYS as readonly string[]).includes(key)) projection[key] = value;
        else rest[key] = value;
      }
      if (Object.keys(projection).length > 0) patchConnectionSnapshot(connectionId, projection);
      if (Object.keys(rest).length > 0) workspaceStore.setState(rest as Partial<Workspace>);
    },
    subscribe: (listener) => {
      // zustand hands listeners (state, previous); the chat stack relies on it.
      let previous = merge(connectionId);
      const wrapped = () => {
        const next = merge(connectionId);
        const last = previous;
        previous = next;
        (listener as (state: Workspace, previous: Workspace) => void)(next, last);
      };
      listeners.add(wrapped);
      return () => {
        listeners.delete(wrapped);
      };
    },
  };
  facades.set(connectionId, facade);
  return facade;
}

/** Renders `children` against `connectionId`'s own projection. */
export function SessionScope({ connectionId, children }: { connectionId: string; children: ReactNode }) {
  const store = useMemo(() => sessionStore(connectionId), [connectionId]);
  return <SessionScopeContext.Provider value={store}>{children}</SessionScopeContext.Provider>;
}
