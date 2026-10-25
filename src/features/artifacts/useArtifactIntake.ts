import { useEffect, useRef } from "react";
import { useWorkspace } from "../../lib/store";
import { saveArtifact, type ArtifactKind } from "./artifacts";

/** `/gui-artifact` 把内容发布到这个 status 键上（见 `gui-extension.ts`）。 */
export const ARTIFACT_STATUS = "gui-artifact";

type Payload = { id?: string; kind?: ArtifactKind; title?: string; body?: string };

/**
 * 接住 agent 写下的产物。
 *
 * 通道是 status：扩展把 JSON 放进 `gui-artifact`，app 读 `state.statuses`。
 * 同一条指令重跑会发布同一个 id，所以「同一个 payload 只落一次库」就够了——
 * 不需要请求号，也不需要清空 status。
 */
export function useArtifactIntake(): void {
  const raw = useWorkspace((state) => state.statuses?.[ARTIFACT_STATUS]);
  const cwd = useWorkspace((state) => state.cwd);
  const session = useWorkspace((state) => state.state?.sessionFile);
  const handled = useRef("");

  useEffect(() => {
    if (!raw || raw === handled.current) return;
    handled.current = raw;
    let payload: Payload;
    try {
      payload = JSON.parse(raw) as Payload;
    } catch {
      return;
    }
    if (!payload.body?.trim()) return;
    console.warn("[artifacts] 收到", payload.id, payload.kind);
    void saveArtifact({
      id: payload.id ?? `artifact-${Date.now().toString(36)}`,
      kind: payload.kind === "html" ? "html" : "document",
      title: payload.title?.trim() || "Untitled",
      body: payload.body,
      sourceCwd: cwd || undefined,
      sourceSessionId: session || undefined,
    }).catch((error: unknown) => {
      // 静默失败是这条链路最贵的错误：工具说「已保存」，文件却没落盘。
      console.warn("[artifacts] 保存失败", error);
    });
  }, [cwd, raw, session]);
}
