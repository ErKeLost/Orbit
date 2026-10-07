import { useEffect, useRef } from "react";
import { useWorkspace } from "../lib/store";
import { Toaster, toast } from "../shared/ui/toast";

/** Bridges protocol-level notifications into the single app-wide toast surface. */
export function ToastHost() {
  const error = useWorkspace((state) => state.error);
  const notices = useWorkspace((state) => state.notices);
  const lastError = useRef<string | null>(null);

  useEffect(() => {
    if (error && error !== lastError.current) {
      lastError.current = error;
      toast.error(error, { description: "操作未完成", duration: 6000 });
      useWorkspace.getState().set({ error: null });
    } else if (!error) {
      lastError.current = null;
    }
  }, [error]);

  useEffect(() => {
    if (!notices.length) return;
    notices.forEach((notice) => toast.info(notice));
    useWorkspace.getState().set({ notices: [] });
  }, [notices]);

  return <Toaster />;
}
