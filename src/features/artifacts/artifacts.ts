import { convertFileSrc } from "@tauri-apps/api/core";
import { invoke } from "../../lib/native";

/** 新增一类产物时，渲染器和存储要一起扩；这个 union 就是那份清单。 */
export type ArtifactKind = "document" | "html";
export const ARTIFACT_KINDS: readonly ArtifactKind[] = ["document", "html"];

export type Artifact = {
  id: string;
  kind: ArtifactKind;
  title: string;
  body: string;
  sourceSessionId?: string;
  sourceCwd?: string;
  createdAt: number;
  updatedAt: number;
};

export type ArtifactUpsert = Omit<Artifact, "createdAt" | "updatedAt">;
export type ArtifactCard = Pick<Artifact, "id" | "kind" | "title"> & { summary?: string };

/** 存过或删过之后广播；读的人和列表各自刷新自己的那一份。 */
export const ARTIFACTS_CHANGED_EVENT = "orbit:artifacts-changed";

export function artifactLabel(kind: ArtifactKind): string {
  switch (kind) {
    case "document":
      return "文档";
    case "html":
      return "页面";
  }
}

/** html 产物在沙箱 iframe 里的地址（`src-tauri/src/artifacts.rs` 的 scheme）。 */
export function htmlArtifactUrl(id: string): string {
  return convertFileSrc(id, "orbitartifact");
}

export const listArtifacts = () => invoke<Artifact[]>("artifacts_list");
export const getArtifact = (id: string) => invoke<Artifact | null>("artifacts_get", { id });
export const deleteArtifact = (id: string) => invoke<void>("artifacts_delete", { id });

export async function saveArtifact(artifact: ArtifactUpsert): Promise<Artifact> {
  const saved = await invoke<Artifact>("artifacts_upsert", { artifact });
  window.dispatchEvent(new Event(ARTIFACTS_CHANGED_EVENT));
  return saved;
}

/**
 * agent 把一个产物挂到对话上：它只带 id/kind/title。
 *
 * 契约和 monocode 的 `postArtifact` 一样——卡片是**引用**，内容存在产物表里。
 * 所以同一条回复里重发同一个 id 是「更新」，不是「加一张新卡」。
 */
export function upsertArtifactCard(cards: readonly ArtifactCard[], card: ArtifactCard): ArtifactCard[] {
  return [...cards.filter((entry) => entry.id !== card.id), card];
}
