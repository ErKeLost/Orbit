import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { readKeepAwake, writeKeepAwake } from "../lib/desktop-integration";
import { saveFileDraft } from "../lib/file-save";
import { readStartupPanel } from "../lib/startup-panel";
import { normalizeProjectPath, useProjects } from "../lib/projects";
import { changeSession, connect, connectRemoteConnection, dispatchRemoteEvent, loadMessages, report, suspendRemoteConnection } from "../lib/rpc";
import { detectRuntimeEnvironment } from "../lib/runtime-environment";
import { useRuntimeDiscovery } from "../lib/runtime-diagnostics";
import { notifyRemoteForeground, openRemoteRuntime, remoteHostSnapshot, storedPairingUri } from "../lib/remote-runtime";
import { restoreRemoteHost } from "../lib/remote-host";
import { restorePersistentState } from "../lib/persistent";
import { toast as gooeyToast } from "../shared/ui/toast";
import { findRemoteConnection, type RemoteConnection, type RemoteHostSnapshot } from "../lib/remote-protocol";
import { useWorkspace } from "../lib/store";
import { CHAT_PANE_ID, useShell } from "../features/shell/shellStore";
import { useWorkspaceTabs } from "../features/shell/use-workspace-tabs";

let runtimeStarted = false;

type PairingState = { uri: string; required: boolean; connecting: boolean; error: string | null };

function preferredRemoteConnection(snapshot: RemoteHostSnapshot, connectionId?: string, cwd?: string, fallbackToFirst = true): RemoteConnection | undefined {
  // The connection the phone last used wins, then the project it was in. Both
  // go through the same alias-tolerant match the rail uses, so a path spelling
  // the Host later canonicalized (a symlinked parent, a trailing slash) still
  // finds its connection instead of dropping the phone to a different project.
  return (connectionId ? findRemoteConnection(snapshot.connections, connectionId) : undefined)
    ?? (cwd ? findRemoteConnection(snapshot.connections, cwd) : undefined)
    ?? (fallbackToFirst ? snapshot.connections[0] : undefined);
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
      useProjects.getState().add(snapshot.connections.map(item => item.cwd));
      // `fallbackToFirst: false` matters: a phone that was in a project must not
      // silently land in whichever connection happens to be first after a
      // reconnect. Prefer the exact connection, then the project it was in (and
      // reopen it through `connect`, which asks the desktop), and only then give
      // up. "It connected but to the wrong project" was this fallback.
      const savedId = localStorage.getItem("orbit.remote.connection.v1") ?? workspace.connectionId;
      const connection = preferredRemoteConnection(snapshot, savedId, workspace.cwd, false);
      if (connection) {
        await connectRemoteConnection(connection, workspace.workspaceMode);
      } else {
        const target = workspace.cwd || snapshot.projects?.[0]?.path;
        if (!target) throw new Error("电脑端当前没有可用的 Pi 连接，请先在电脑打开工作区");
        await connect(target, workspace.workspaceMode);
      }
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
      // Pairing must not require the desktop to already have a project open.
      // If the Host has registry projects but no live connection, open the first
      // one the way a tap on the phone's rail would; the workspace pointer then
      // follows the same path as every later switch.
      const savedId = localStorage.getItem("orbit.remote.connection.v1");
      const connection = preferredRemoteConnection(snapshot, savedId ?? undefined, useWorkspace.getState().cwd);
      const projects = [...snapshot.connections.map(item => item.cwd), ...(snapshot.projects ?? []).map(project => project.path)];
      useProjects.getState().add(projects);
      if (connection) {
        useWorkspace.getState().set({ runtimeTarget: "mobile", cwd: connection.cwd, connectionId: connection.id, workspaceMode: "project", error: null });
        await connectRemoteConnection(connection);
      } else {
        const target = snapshot.projects?.[0]?.path;
        if (!target) throw new Error("电脑端还没有项目，请先在电脑上打开一个项目");
        useWorkspace.getState().set({ runtimeTarget: "mobile", cwd: target, connectionId: "", workspaceMode: "project", error: null });
        await connect(target, "project");
      }
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

  // Launch defaults: where Orbit lands, and holding the machine awake.
  //
  // Neither is per-session state. The landing page is pinned before the project
  // auto-restore settles (a connection does not move the panel), so a cold
  // start opens — in the default configuration — on 「移动端」, with the QR code
  // and the Host switch already on screen for the phone that is about to scan
  // it. The wake assertion is process-wide and its only writer is this effect,
  // which re-runs with the app: nothing else can toggle it behind the user's
  // back, and the process exit releases it.
  const appliedLaunchDefaults = useRef(false);
  useEffect(() => {
    if (runtimeTarget !== "desktop" || appliedLaunchDefaults.current) return;
    appliedLaunchDefaults.current = true;
    // 旧版本遗留的「控制台」面板已删除；落地值若是它，回聊天页。
    const landing = readStartupPanel();
    useWorkspace.getState().set({ panel: (landing as string) === "console" ? "chat" : landing });
    void writeKeepAwake(readKeepAwake()).catch(report);
  }, [runtimeTarget]);

  // 同理：设置页里残留的 console 页签回落到 General。
  useEffect(() => {
    const state = useWorkspace.getState();
    if ((state.settingsPage as string) === "console") state.set({ settingsPage: "general" });
    if ((state.panel as string) === "console") state.set({ panel: "chat" });
  }, []);

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
  const { splitSession } = useWorkspaceTabs();
  const splitSessionRef = useRef(splitSession);
  splitSessionRef.current = splitSession;
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
      if (event.key.toLowerCase() === "w") {
        // Orbit's ⌘W closes the focused pane (⌘⇧W closes every editor pane).
        const shell = useShell.getState();
        const workspace = shell.workspaces.find((item) => item.id === shell.activeWorkspaceId) ?? shell.workspaces[0];
        const editors = Object.keys(workspace.panes);
        if (event.shiftKey) {
          if (editors.length === 0) return;
          event.preventDefault();
          for (const id of editors) shell.closePane(id);
          return;
        }
        if (workspace.activePane === CHAT_PANE_ID || !workspace.panes[workspace.activePane]) return;
        event.preventDefault();
        shell.closePane(workspace.activePane);
      }
      if (event.key.toLowerCase() === "d") {
        // Orbit's split-right / split-down: a new session beside this one.
        const shell = useShell.getState();
        const workspace = shell.workspaces.find((item) => item.id === shell.activeWorkspaceId) ?? shell.workspaces[0];
        if (splitSessionRef.current && workspace?.sessions[workspace.activePane]) {
          event.preventDefault();
          void splitSessionRef.current(workspace.activePane, event.shiftKey ? "down" : "right");
        }
      }
      if (event.key.toLowerCase() === "k") {
        // Search everything, like Orbit's ⌘K.
        event.preventDefault();
        useWorkspace.getState().set({ panel: "search" });
      }
      if (event.key.toLowerCase() === "f" && event.shiftKey) {
        // VS Code's other half of search: ⌘F finds in the open file (the
        // editor owns that key itself), ⌘⇧F searches the whole workspace.
        event.preventDefault();
        useWorkspace.getState().set({ panel: "search" });
        return;
      }
      if (event.key.toLowerCase() === "s") {
        // Save the focused editor pane. The editor binds ⌘S itself while it has
        // focus; this catches the case where the pane is focused but the caret
        // was in something else (a tab, the footer, the transcript).
        const shell = useShell.getState();
        const workspace = shell.workspaces.find((item) => item.id === shell.activeWorkspaceId) ?? shell.workspaces[0];
        const path = workspace?.panes[workspace.activePane]?.activeFile;
        if (!path) return;
        event.preventDefault();
        // Saving is silent — the tab dot disappearing is the acknowledgement.
        void saveFileDraft(path).catch(report);
        return;
      }
      if (event.key.toLowerCase() === "j") {
        // Toggle the built-in terminal dock (Orbit's ⌘J).
        event.preventDefault();
        const shell = useShell.getState();
        shell.setTerminalOpen(!shell.terminalOpen);
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
