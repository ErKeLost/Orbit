import type { DisplayMessage } from "./protocol";

// v1 里存的是旧规则算出来的数：一组有多段运行时只记了最后一段（真实案例：11m45s
// 的一轮被记成 2s）。这些值会盖掉磁盘上重算的结果，所以直接弃用；下一次 settle 会
// 按新规则重新写入，没再跑过的历史会话则回退到 Rust 从 JSONL 算出的整轮时长。
const STORAGE_PREFIX = "pi-gui:turn-durations:v2:";
const MAX_TURNS_PER_SESSION = 500;

type DurationMap = Record<string, number>;

function keyForSession(sessionFile: string) {
  return `${STORAGE_PREFIX}${sessionFile}`;
}

export function turnDurationId(items: DisplayMessage[]) {
  const assistant = items.find(item => item.message.role === "assistant");
  if (!assistant) return null;
  if (typeof assistant.message.timestamp === "number" && Number.isFinite(assistant.message.timestamp)) {
    return `timestamp:${assistant.message.timestamp}`;
  }
  const content = Array.isArray(assistant.message.content) ? assistant.message.content : [];
  const toolCall = content.find(part => part.type === "toolCall" && part.id);
  return toolCall?.id ? `tool:${toolCall.id}` : null;
}

/**
 * 一组可见的「轮」实际工作了多久。
 *
 * 正常情况下只有首条 assistant 带时钟：reducer 在每次 `agent_settled` 都把“从这一组
 * 第一次运行到现在”的墙钟时间写在它上面（见 `visibleTurnStart`）。这里仍然做加法而
 * 不是取最后一个：旧版 reducer 是每段运行各写一个，取最后一个会把一轮 11m45s 的工作
 * 显示成最后那一小段的 2s；升级前就已在内存里的会话可能还带着那种数据，求和至少
 * 不会把前面的工作丢掉。历史会话没有逐段耗时，才退回 `saved` 里存下的那个值。
 */
export function turnElapsedMs(items: DisplayMessage[], saved: DurationMap = {}): number | undefined {
  const runs = items.filter(item => typeof item.elapsedMs === "number");
  if (runs.length > 0) return runs.reduce((total, item) => total + Math.max(0, item.elapsedMs ?? 0), 0);
  const id = turnDurationId(items);
  return id ? saved[id] : undefined;
}

export function readTurnDurations(sessionFile: string): DurationMap {
  if (!sessionFile || typeof localStorage === "undefined") return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(keyForSession(sessionFile)) ?? "{}") as DurationMap;
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => Number.isFinite(value) && value >= 0));
  } catch {
    return {};
  }
}

export function saveTurnDurations(sessionFile: string, entries: DurationMap) {
  if (!sessionFile || typeof localStorage === "undefined" || Object.keys(entries).length === 0) return;
  const current = readTurnDurations(sessionFile);
  const merged = { ...current, ...entries };
  const recent = Object.fromEntries(Object.entries(merged).slice(-MAX_TURNS_PER_SESSION));
  try {
    localStorage.setItem(keyForSession(sessionFile), JSON.stringify(recent));
  } catch {
    // A missing duration is preferable to disrupting the conversation when storage is unavailable.
  }
}
