import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { browserViewReconcile } from "../../lib/browser-view";
import { browserTabPaths, useShell } from "../shell/shellStore";

/**
 * The browser column's app-level wiring: once per document, and not anywhere
 * else.
 *
 * A view is a native child web view this process owns (`browser_view.rs`), while
 * the tabs that describe it live in this document's state. A reload rebuilds
 * that state from nothing, so the views outlive the only thing that could close
 * them, and startup is the one moment the frontend knows the complete truth
 * about which tabs exist. `browser:open` — the agent's channel asking for a tab —
 * arrives on the same subject, so it is answered here too: a tab gets the pane's
 * geometry, which is the only placement that stays right.
 *
 * This is the browser feature's own startup, so it lives with the browser
 * feature rather than in the app's composition root.
 */
export function useBrowserViews() {
  useEffect(() => {
    const tabsNow = () => browserTabPaths(useShell.getState().workspaces);
    void browserViewReconcile(tabsNow()).catch(() => undefined);
    const pending = listen<{ url?: string; tab?: string }>("browser:open", event => {
      // The tab id is the app's own (`browser_view.rs` generates it and returns
      // it to the run), so the agent and this document agree on which tab the
      // run owns. Without it the agent drove "whatever is in front".
      const tab = event.payload?.tab?.trim();
      useShell.getState().openBrowser(event.payload?.url ?? "", tab ? { path: tab } : undefined);
    });
    // ...and the other half of that ownership: when the run ends, the app closes
    // the tab it minted. Without this the tab entry would outlive its page — the
    // strip would grow by one tab per run, and each one would re-create a view
    // for a page that no longer exists.
    const closing = listen<{ tab?: string }>("browser:close", event => {
      const tab = event.payload?.tab?.trim();
      if (tab) useShell.getState().closeFile(tab);
    });
    // View lifetime follows **tab** lifetime, not "which tab is in front".
    //
    // Opening a browser tab creates a native view, and the component that owns it
    // unmounts whenever another file becomes the pane's active tab — so closing
    // on unmount destroyed the page, its scroll and its session every time the
    // user merely switched tabs. A view may only be destroyed when its tab is
    // gone, and the store is the only thing that knows when that happened. The
    // app already owns the sweep (`browser_view_reconcile`); this is what calls
    // it after startup.
    let last = tabsNow().join("|");
    const unsubscribe = useShell.subscribe(state => {
      const tabs = browserTabPaths(state.workspaces);
      const key = tabs.join("|");
      if (key === last) return;
      last = key;
      void browserViewReconcile(tabs).catch(() => undefined);
    });
    return () => {
      unsubscribe();
      void pending.then(unlisten => unlisten());
      void closing.then(unlisten => unlisten());
    };
  }, []);
}
