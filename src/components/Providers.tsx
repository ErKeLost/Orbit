import { useEffect, type ReactNode } from "react";
import { LazyMotion, MotionConfig, domAnimation } from "motion/react";
import { PromptProvider } from "./UI";
import { ToastHost } from "./ToastHost";
import { UpdateChecker } from "./UpdateChecker";
import { installAppearance } from "../lib/appearance";
import { useWorkspace } from "../lib/store";
import { setRemoteHostTheme } from "../lib/remote-host";

installAppearance(() => useWorkspace.getState().runtimeTarget === "desktop");

function PageVisibilitySync() {
  useEffect(() => {
    const update = () => {
      document.documentElement.dataset.pageVisible = String(!document.hidden);
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return null;
}

/** Mobile follows the desktop's scheme; the desktop reports its own to the Host. */
function RemoteThemeSync() {
  const runtimeTarget = useWorkspace((state) => state.runtimeTarget);
  const remoteTheme = useWorkspace((state) => state.remoteTheme);
  useEffect(() => {
    if (runtimeTarget === "mobile" && remoteTheme) {
      void import("../lib/appearance").then(({ useAppearance }) => useAppearance.getState().setPreference(remoteTheme));
    }
  }, [remoteTheme, runtimeTarget]);
  useEffect(() => {
    if (runtimeTarget !== "desktop") return;
    let unsubscribe: (() => void) | undefined;
    void import("../lib/appearance").then(({ useAppearance }) => {
      const push = () => void setRemoteHostTheme(useAppearance.getState().scheme).catch(() => undefined);
      push();
      unsubscribe = useAppearance.subscribe((state, previous) => {
        if (state.scheme !== previous.scheme) push();
      });
    });
    return () => unsubscribe?.();
  }, [runtimeTarget]);
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domAnimation}>
      <MotionConfig reducedMotion="user">
        <PromptProvider>
          <PageVisibilitySync />
          <RemoteThemeSync />
          <UpdateChecker />
          <ToastHost />
          {children}
        </PromptProvider>
      </MotionConfig>
    </LazyMotion>
  );
}
