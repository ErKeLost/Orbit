import type { GitHistoryCommit } from "../../../platform/tauri/fs";

/**
 * 历史面板的搜索是纯客户端的：已加载的这批提交就在内存里，走一次
 * `git log --grep` 反而多一次往返，而且「只搜已加载范围」这件事迟早要
 * 面对（等做到「加载更多 / 搜全历史」时再换后端）。
 *
 * 匹配的是人真正记得住的东西：标题、作者、短 sha、完整 sha 前缀、以及分支/标签名。
 */

export type HistoryField = "subject" | "author" | "sha" | "ref";

/** 命中的字段按固定顺序回报：查询词的先后不该改变界面拿到的形状。 */
const FIELD_ORDER: readonly HistoryField[] = ["subject", "author", "sha", "ref"];

export type HistoryMatch = {
  commit: GitHistoryCommit;
  /** 命中的字段，界面用来说明「为什么这条留下了」。 */
  fields: HistoryField[];
  /** 在原始（未过滤）列表里的下标，图表布局仍按完整历史算。 */
  index: number;
};

/** 空格分词，多个词是「都要命中」——「作者 + 关键词」是最常见的用法。 */
export function parseHistoryQuery(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

export function matchHistoryCommit(
  commit: GitHistoryCommit,
  terms: readonly string[],
): HistoryField[] | null {
  if (terms.length === 0) return [];
  const subject = commit.subject.toLowerCase();
  const author = commit.author.toLowerCase();
  const sha = commit.sha.toLowerCase();
  const shortSha = commit.shortSha.toLowerCase();
  const refs = commit.refs.map((ref) => ref.name.toLowerCase());

  const fields = new Set<HistoryField>();
  for (const term of terms) {
    if (subject.includes(term)) {
      fields.add("subject");
    } else if (author.includes(term)) {
      fields.add("author");
    } else if (shortSha.includes(term) || sha.startsWith(term)) {
      fields.add("sha");
    } else if (refs.some((name) => name.includes(term))) {
      fields.add("ref");
    } else {
      return null;
    }
  }
  return FIELD_ORDER.filter((field) => fields.has(field));
}

export function filterHistoryCommits(
  commits: readonly GitHistoryCommit[],
  query: string,
): HistoryMatch[] {
  const terms = parseHistoryQuery(query);
  if (terms.length === 0) {
    return commits.map((commit, index) => ({ commit, fields: [], index }));
  }
  const matches: HistoryMatch[] = [];
  commits.forEach((commit, index) => {
    const fields = matchHistoryCommit(commit, terms);
    if (fields) matches.push({ commit, fields, index });
  });
  return matches;
}

/**
 * 命中片段的字符位置，交给 `MatchText` 上色。
 *
 * 用位置而不是切好的片段：`MatchText` 已经按位置渲染，切片段反而要在两处
 * 维护同一套「大小写不敏感但保留原文」的逻辑。
 */
export function matchPositions(text: string, terms: readonly string[]): number[] {
  if (terms.length === 0 || !text) return [];
  const lower = text.toLowerCase();
  // 极少数语言里 toLowerCase 会改变长度（如 İ），那时宁可不描，也不错位描。
  if (lower.length !== text.length) return [];
  const marked = new Set<number>();
  for (const term of terms) {
    let from = lower.indexOf(term);
    while (from >= 0) {
      for (let offset = 0; offset < term.length; offset += 1) {
        marked.add(from + offset);
      }
      from = lower.indexOf(term, from + term.length);
    }
  }
  return [...marked].sort((a, b) => a - b);
}
