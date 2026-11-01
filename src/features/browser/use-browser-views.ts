import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { browserViewClose, browserViewRestore } from "../../lib/browser-view";
import { browserTabPaths, useShell } from "../shell/shellStore";

/** Subscribe to native page lifetime events once per renderer. Rust owns the
 * live directory; reloading React restores it, while explicit tab removal closes
 * only the removed page. Hiding the panel leaves every native page running. */
export function useBrowserViews() {
  useEffect(() => {
    const tabsNow = () => browserTabPaths(useShell.getState().browserTabs);
    const pending = listen<{ url?: string; tab?: string }>("browser:open", event => {
      // The tab id is the app's own (`browser_view.rs` generates it and returns
      // it to the run), so the agent and this document agree on which tab the
      // run owns. Without it the agent drove "whatever is in front".
      const tab = event.payload?.tab?.trim();
      useShell.getState().openBrowser(event.payload?.url ?? "", tab ? { path: tab } : undefined);
    });
    // A browser run now releases its lease when it ends. The page is deliberately
    // kept in the strip, so its cookies, scroll position and navigation history
    // remain available for the user and the next run.
    const closing = listen<{ tab?: string }>("browser:close", event => {
      const tab = event.payload?.tab?.trim();
      if (tab) useShell.getState().closeFile(tab);
    });
    const released = listen<{ tab?: string }>("browser:released", event => {
      const tab = event.payload?.tab?.trim();
      if (tab) useShell.getState().releaseBrowser(tab);
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
    let previous = new Set(tabsNow());
    const unsubscribe = useShell.subscribe(state => {
      const current = new Set(browserTabPaths(state.browserTabs));
      for (const tab of previous) if (!current.has(tab)) void browserViewClose(tab).catch(() => undefined);
      previous = current;
    });
    // Subscribe first, then restore the host's directory. A renderer reload
    // cannot delete the page that an in-flight Pi task is still controlling.
    let disposed = false;
    void Promise.all([pending, closing, released]).then(() => browserViewRestore()).then(tabs => {
      if (disposed) return;
      useShell.setState(state => {
        const known = new Set(state.browserTabs.map(tab => tab.path));
        const restored = tabs.filter(tab => !known.has(tab.tab)).map(tab => ({ path: tab.tab, url: tab.url }));
        return { browserTabs: [...state.browserTabs, ...restored], browserActive: state.browserActive ?? restored[0]?.path ?? null };
      });
    }).catch(() => undefined);
    // ...and the third outcome of a run: it stopped where only the person can
    // go on — a sign-in wall, a checkout. The app keeps that view alive and says
    // so here; the tab becomes the column's own instead of vanishing and leaving
    // the reader on whatever page was in front before the run started.
    const handedOver = listen<{ url?: string; tab?: string }>("browser:handoff", event => {
      const tab = event.payload?.tab?.trim();
      if (tab) useShell.getState().adoptBrowser(tab, event.payload?.url);
    });
    return () => {
      disposed = true;
      unsubscribe();
      void pending.then(unlisten => unlisten());
      void closing.then(unlisten => unlisten());
      void released.then(unlisten => unlisten());
      void handedOver.then(unlisten => unlisten());
    };
  }, []);
}
