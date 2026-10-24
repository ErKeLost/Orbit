import { runHighlight } from "./core";
import type { HighlightRequest, HighlightResponse } from "./types";

/**
 * 这个 Worker 只做一件事：把 shiki 挪出 UI 线程，回传纯数据。
 *
 * 聊天代码块、文件预览、diff 行共用同一个 Worker 池（见 `index.ts`），
 * 所以一套已加载的语法/主题能覆盖整个应用，不会每处各热一遍。
 */
self.onmessage = (event: MessageEvent<HighlightRequest>) => {
  const { id, kind, code, lang } = event.data;
  runHighlight(kind, code, lang)
    .then((result) =>
      self.postMessage({ id, result } satisfies HighlightResponse),
    )
    .catch((error: unknown) =>
      self.postMessage({
        id,
        error: error instanceof Error ? error.message : String(error),
      } satisfies HighlightResponse),
    );
};
