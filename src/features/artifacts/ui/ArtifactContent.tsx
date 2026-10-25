import { useEffect, useState } from "react";
import { Markdown } from "../../../components/Markdown";
import { HtmlArtifactFrame } from "./HtmlArtifactFrame";
import { ARTIFACTS_CHANGED_EVENT, getArtifact, type Artifact } from "../artifacts";

/** 读一份产物，并跟着它后面的保存刷新——所有读者框共用这一份。 */
export function useArtifact(id: string) {
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let request = 0;
    setArtifact(null);
    setLoaded(false);
    setError(null);
    const refresh = () => {
      const token = ++request;
      void getArtifact(id).then(
        (saved) => {
          if (!live || token !== request) return;
          setArtifact(saved);
          setError(null);
          setLoaded(true);
        },
        () => {
          if (!live || token !== request) return;
          setError("读取失败。");
          setLoaded(true);
        },
      );
    };
    refresh();
    window.addEventListener(ARTIFACTS_CHANGED_EVENT, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      window.removeEventListener(ARTIFACTS_CHANGED_EVENT, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [id]);
  return { artifact, loaded, error, setError };
}

/** 每种产物自己决定在共用的读者框里放什么。 */
export function ArtifactContent({ artifact }: { artifact: Artifact }) {
  switch (artifact.kind) {
    case "document":
      return (
        <div className="markdown-preview">
          <Markdown content={artifact.body} />
        </div>
      );
    case "html":
      return <HtmlArtifactFrame id={artifact.id} title={artifact.title} version={artifact.updatedAt} />;
  }
}
