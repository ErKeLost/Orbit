import { useEffect } from "react";
import { generateText } from "../../lib/text-gen";
import { connectionSnapshot, renameSession } from "../../lib/rpc";

const titled = new Set<string>();

/**
 * After the first turn settles, a configured text model may name the session.
 * Pi keeps the name; we do not start a coding session just to write a title.
 */
export function useSessionTitles() {
  useEffect(() => {
    const onSettled = (event: Event) => {
      const detail = (event as CustomEvent<{ cwd?: string; sessionFile?: string; connectionId?: string; title?: string; aborted?: boolean; error?: string | null }>).detail;
      if (!detail?.sessionFile || !detail.cwd || detail.aborted || detail.error) return;
      if (titled.has(detail.sessionFile)) return;
      const name = (detail.connectionId ? connectionSnapshot(detail.connectionId)?.state?.sessionName : undefined)?.trim();
      if (name) {
        titled.add(detail.sessionFile);
        return;
      }
      const seed = (detail.title ?? "").trim();
      if (seed.length < 8) return;
      titled.add(detail.sessionFile);
      // Rules from T3 `initialThreadTitlePrompt`. Orbit has no linked-PR lookup, so that clause is omitted.
      const prompt = [
        "Generate a title that will help the user recognize this Orbit session weeks later.",
        "Return JSON with keys title and needsRefinement.",
        "Set needsRefinement to true only if the subject is still unknown, such as an unresolved link, \"fix this\", or an unexplained attachment. Otherwise set it to false.",
        "",
        "Title the subject and outcome. Discard incidental instructions.",
        "- 3-8 words, fewer than 40 characters.",
        "- Use a compact noun phrase or clear action phrase.",
        "- Do not claim the work is complete.",
        "- Do not copy and truncate the user's message.",
        "- Avoid quotes, labels, filler, and trailing punctuation.",
        "",
        "User message:",
        seed.slice(0, 8_000),
      ].join("\n");
      void generateText(prompt).then((title) => {
        const parsed = title?.match(/\{[\s\S]*\}/)?.[0];
        let clean = title?.replace(/[\r\n"]/g, " ").trim() ?? "";
        if (parsed) {
          try {
            const value = JSON.parse(parsed) as { title?: unknown };
            if (typeof value.title === "string") clean = value.title.trim();
          } catch { /* keep the raw line */ }
        }
        clean = clean.slice(0, 40);
        if (!clean) return;
        return renameSession(detail.sessionFile!, clean);
      }).catch(() => undefined);
    };
    window.addEventListener("orbit-turn-settled", onSettled);
    return () => window.removeEventListener("orbit-turn-settled", onSettled);
  }, []);
}
