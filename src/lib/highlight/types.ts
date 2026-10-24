/**
 * shiki 的 Worker 协议。
 *
 * 高亮是这套界面里最大的一块同步计算：25 万字符的 diff、或一整段塞满代码块的
 * 长会话，单次 tokenize 就是几十毫秒，正好和流式提交、滚动抢主线程。跨这条边界
 * 的全部是纯数据，所以主线程那份缓存可以只按源码文本做键。
 */

/**
 * 一段被高亮的文字。`darkColor` 是 shiki 双主题产出的 `--shiki-dark` 值，
 * 两个调色板一次算完，切主题时不再重新 tokenize。
 */
export type HighlightToken = { text: string; color?: string; darkColor?: string };

export type HighlightResult =
  | { kind: "html"; html: string }
  | { kind: "lines"; lines: HighlightToken[][] };

export type HighlightKind = HighlightResult["kind"];

export type HighlightRequest = {
  id: number;
  kind: HighlightKind;
  code: string;
  lang: string;
};

export type HighlightResponse = {
  id: number;
  result?: HighlightResult;
  error?: string;
};
