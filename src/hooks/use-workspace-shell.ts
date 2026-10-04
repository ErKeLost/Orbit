import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { normalizeProjectPath, useProjects } from "../lib/projects";
import { changeSession, connect, connectRemoteConnection, dispatchRemoteEvent, loadMessages, report, suspendRemoteConnection } from "../lib/rpc";
import { detectRuntimeEnvironment } from "../lib/runtime-environment";
import { useRuntimeDiscovery } from "../lib/runtime-diagnostics";
import { notifyRemoteForeground, openRemoteRuntime, remoteHostSnapshot, storedPairingUri } from "../lib/remote-runtime";
import { restoreRemoteHost } from "../lib/remote-host";
import { restorePersistentState } from "../lib/persistent";
import { gooeyToast } from "goey-toast";
import type { RemoteConnection, RemoteHostSnapshot } from "../lib/remote-protocol";
import { useWorkspace } from "../lib/store";

let runtimeStarted = false;

type PairingState = { uri: string; required: boolean; connecting: boolean; error: string | null };

function preferredRemoteConnection(snapshot: RemoteHostSnapshot, connectionId?: string, cwd?: string): RemoteConnection | undefined {
  return snapshot.connections.find(item => item.id === connectionId)
    ?? snapshot.connections.find(item => item.cwd === cwd)
    ?? snapshot.connections[0];
}

export function useWorkspaceBootstrap() {
  const runtimeTarget = useWorkspace(state => state.runtimeTarget);
  const [pairing, setPairing] = useState<PairingState>(() => ({ uri: storedPairingUri(), required: false, connecting: false, error: null }));
  const [remoteRevision, setRemoteRevision] = useState(0);
  const remoteReady = useRef(false);
  const recoveringRemote = useRef(false);
  const discovery = useRuntimeDiscovery(runtimeTarget === "desktop");

  const recoverRemote = useCallback(async () => {
    if (recoveringRemote.current) return;
    recoveringRemote.current = true;
    try {
      const workspace = useWorkspace.getState();
      const snapshot = await remoteHostSnapshot();
      if (snapshot.theme || snapshot.machineName) useWorkspace.getState().set({ ...(snapshot.theme ? { remoteTheme: snapshot.theme } : {}), ...(snapshot.machineName ? { remoteMachineName: snapshot.machineName } : {}) });
      const savedId = localStorage.getItem("orbit.remote.connection.v1") ?? workspace.connectionId;
      const connection = preferredRemoteConnection(snapshot, savedId, workspace.cwd);
      if (!connection) throw new Error("电脑端当前没有可用的 Pi 连接，请先在电脑打开工作区");
      useProjects.getState().add(snapshot.connections.map(item => item.cwd));
      await connectRemoteConnection(connection, workspace.workspaceMode);
      setPairing(current => ({ ...current, connecting: false, required: false, error: null }));
      setRemoteRevision(value => value + 1);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      useWorkspace.getState().set({ connection: "offline", error: message });
      setPairing(current => ({ ...current, connecting: false, required: true, error: message }));
    } finally {
      recoveringRemote.current = false;
    }
  }, []);

  const attachRemote = useCallback(async (uri: string) => {
    remoteReady.current = false;
    setPairing(current => ({ ...current, uri, connecting: true, required: true, error: null }));
    try {
      const snapshot = await openRemoteRuntime(uri, {
        onPiEvent: dispatchRemoteEvent,
        onEvent: event => {
          if ((event.type === "host.theme" || event.type === "host.hello") && event.theme) useWorkspace.getState().set({ remoteTheme: event.theme });
          if (event.type === "host.hello" && event.machineName) useWorkspace.getState().set({ remoteMachineName: event.machineName });
          if (event.type === "connection.invalidated") void loadMessages(event.project).catch(report);
          if (event.type === "connection.closed" && event.project === useWorkspace.getState().connectionId) {
            useWorkspace.getState().set({ connection: "connecting", error: null });
            void recoverRemote();
          }
        },
        onReconnected: () => { void recoverRemote() },
        onState: state => {
          if (useWorkspace.getState().runtimeTarget !== "mobile" || !remoteReady.current) return;
          if (state === "online") { void recoverRemote(); return; }
          suspendRemoteConnection();
          setPairing(current => ({ ...current, required: false, connecting: true, error: null }));
        },
        onError: error => { if (!remoteReady.current) useWorkspace.getState().set({ error: error.message }); },
      });
      remoteReady.current = true;
      if (snapshot.theme || snapshot.machineName) useWorkspace.getState().set({ ...(snapshot.theme ? { remoteTheme: snapshot.theme } : {}), ...(snapshot.machineName ? { remoteMachineName: snapshot.machineName } : {}) });
      const savedId = localStorage.getItem("orbit.remote.connection.v1");
      const connection = preferredRemoteConnection(snapshot, savedId ?? undefined, useWorkspace.getState().cwd);
      if (!connection) throw new Error("电脑端当前没有可用的 Pi 连接，请先在电脑打开工作区");
      useWorkspace.getState().set({ runtimeTarget: "mobile", cwd: connection.cwd, connectionId: connection.id, workspaceMode: "project", error: null });
      useProjects.getState().add(snapshot.connections.map(item => item.cwd));
      await connectRemoteConnection(connection);
      setPairing(current => ({ ...current, uri, connecting: false, required: false, error: null }));
      setRemoteRevision(value => value + 1);
    } catch (error) {
      setPairing(current => ({ ...current, connecting: false, required: true, error: String(error instanceof Error ? error.message : error) }));
    }
  }, [recoverRemote]);

  useEffect(() => {
    if (runtimeStarted) return;
    runtimeStarted = true;
    void detectRuntimeEnvironment().then(environment => {
      useWorkspace.getState().set({ runtimeTarget: environment.target, runtimePlatform: environment.platform, ...(environment.platform !== "macos" ? { computerUseEnabled: false } : {}) });
      if (environment.target === "mobile") {
        const uri = storedPairingUri();
        const preview = environment.platform === "preview";
        if (uri && !preview) void attachRemote(uri);
        else setPairing(current => ({ ...current, required: true }));
      }
    }).catch(report);
  }, [attachRemote]);

  // Mobile access does not survive a quit on its own — the Host lives in this
  // process. Granting screen recording requires exactly one restart (TCC is
  // re-read at launch), which used to leave the phone retrying forever against
  // a process that was no longer listening. Restoring the intent the user
  // already expressed is what closes that loop.
  // Restore the durable copy *before* the remote host is restored, because the
  // host's own intent ("should mobile access come back") lives in it.
  useEffect(() => {
    void restorePersistentState();
  }, []);

  const restoredHost = useRef(false);
  useEffect(() => {
    if (runtimeTarget !== "desktop" || restoredHost.current) return;
    restoredHost.current = true;
    void restoreRemoteHost()
      .then(info => { if (info) gooeyToast.success("移动访问已恢复", { description: `${info.advertisedAddress}:${info.port}`, showTimestamp: false }); })
      .catch(() => gooeyToast.warning("移动访问未能自动恢复", { description: "请在「移动端」里重新启用", showTimestamp: false }));
  }, [runtimeTarget]);

  useEffect(() => {
    if (runtimeTarget !== "mobile") return;
    const resume = () => {
      if (document.visibilityState === "hidden") return;
      notifyRemoteForeground("app-resume");
    };
    const networkChanged = () => notifyRemoteForeground("network-change");
    const focus = () => notifyRemoteForeground("focus");
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", networkChanged);
    window.addEventListener("offline", networkChanged);
    window.addEventListener("focus", focus);
    return () => {
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", networkChanged);
      window.removeEventListener("offline", networkChanged);
      window.removeEventListener("focus", focus);
    };
  }, [runtimeTarget]);

  useEffect(() => {
    if (!discovery.data) return;
    useWorkspace.getState().set({ homeDir: discovery.data.home, piVersion: discovery.data.piVersion });
    if (localStorage.getItem("pi-gui.workspaceMode") === "home") {
      void connect(discovery.data.home, "home").catch(report);
      return;
    }
    const storedPath = localStorage.getItem("pi-gui.cwd");
    const savedProjects = useProjects.getState().projects;
    if (!storedPath && savedProjects.length === 0) {
      useWorkspace.getState().set({ cwd: "", workspaceMode: "project" });
      return;
    }
    const path = (storedPath ? normalizeProjectPath(storedPath) : "") || savedProjects[0]?.path || normalizeProjectPath(discovery.data.cwd);
    useProjects.getState().add([path]);
    void connect(path, "project").catch(report);
  }, [discovery.data]);

  useEffect(() => {
    if (discovery.error) useWorkspace.getState().set({ error: String(discovery.error) });
  }, [discovery.error]);

  return { runtimeTarget, pairing, remoteRevision, setPairingUri: (uri: string) => setPairing(current => ({ ...current, uri, error: null })), connectPairing: attachRemote };
}

export function useWorkspaceShortcuts(
  online: boolean,
  setSidebarOpen: Dispatch<SetStateAction<boolean>>,
) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "r") {
        // Browser-style refresh: reloads the webview, so a dev rebuild is picked
        // up without quitting the app.
        event.preventDefault();
        window.location.reload();
      }
      if (event.key === "n") {
        event.preventDefault();
        if (online) void changeSession({ type: "new_session" }).catch(report);
      }
      if (event.key === ",") {
        event.preventDefault();
        useWorkspace.getState().set({ panel: "settings", settingsPage: "general" });
      }
      if (event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSidebarOpen(value => !value);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [online, setSidebarOpen]);
}
