import { useSyncExternalStore } from "react";

/**
 * 按项目的通知静音。
 *
 * 「完成通知」是个全局开关，但真正吵人的场景总是具体的：某个项目在跑长任务，
 * 或者你正在它上面干活、每次跑完都弹一次。所以静音按**项目路径**记，并且可以
 * 带一个到期时间——到期自己就失效，不需要谁记得回来关掉（monocode 的
 * `NotificationMuteControl` + `ProjectNotificationMute` 是同一套思路）。
 *
 * 存在 localStorage 里：它是本机偏好，不需要跟着配对走。
 */
const KEY = "orbit.notifyMuted.v1";
const CHANGE = "orbit:notify-muted-change";

/** `until` 是毫秒时间戳；`null` 表示一直静音。 */
export type MuteEntry = { until: number | null };
export type MuteState = Record<string, MuteEntry>;

function read(): MuteState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as MuteState;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

let state: MuteState = read();
const listeners = new Set<() => void>();

function write(next: MuteState) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* 私密模式 / 配额：内存里这一份仍然有效 */
  }
  for (const listener of listeners) listener();
  window.dispatchEvent(new Event(CHANGE));
}

/** 到期时间已经过去的条目，读的时候顺手丢掉，界面不会留一条僵尸开关。 */
function live(entry: MuteEntry | undefined, now: number): boolean {
  if (!entry) return false;
  return entry.until === null || entry.until > now;
}

export function isProjectMuted(project: string, now = Date.now()): boolean {
  if (!project) return false;
  return live(state[project], now);
}

export function muteProject(project: string, until: number | null) {
  if (!project) return;
  write({ ...state, [project]: { until } });
}

export function unmuteProject(project: string) {
  if (!(project in state)) return;
  const next = { ...state };
  delete next[project];
  write(next);
}

/** 在下一次 tick 里清掉过期的条目；由设置页和通知闸门各自调用一次。 */
export function pruneMuted(now = Date.now()) {
  const next = Object.fromEntries(
    Object.entries(state).filter(([, entry]) => live(entry, now)),
  ) as MuteState;
  if (Object.keys(next).length !== Object.keys(state).length) write(next);
}

export function useMutedProjects(): MuteState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      const onStorage = () => listener();
      window.addEventListener(CHANGE, onStorage);
      window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(listener);
        window.removeEventListener(CHANGE, onStorage);
        window.removeEventListener("storage", onStorage);
      };
    },
    () => state,
    () => state,
  );
}

/** 静音选项，写成人话；`until` 给 `muteProject`。 */
export function muteOptions(now = Date.now()): { value: string; label: string; until: number | null }[] {
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  return [
    { value: "off", label: "不静音", until: null },
    { value: "1h", label: "1 小时", until: now + 60 * 60 * 1000 },
    { value: "today", label: "今天", until: endOfToday.getTime() },
    { value: "7d", label: "7 天", until: now + 7 * 24 * 60 * 60 * 1000 },
    { value: "forever", label: "一直静音", until: null },
  ];
}

/** 当前条目对应的选项值，用于把选择框停在正确的位置。 */
export function muteOptionFor(entry: MuteEntry | undefined, now = Date.now()): string {
  if (!live(entry, now) || !entry) return "off";
  if (entry.until === null) return "forever";
  const remaining = entry.until - now;
  if (remaining <= 60 * 60 * 1000 + 1000) return "1h";
  if (remaining <= 24 * 60 * 60 * 1000) return "today";
  return "7d";
}

export function muteRemainingLabel(entry: MuteEntry | undefined, now = Date.now()): string {
  if (!live(entry, now) || !entry) return "";
  if (entry.until === null) return "一直静音";
  const minutes = Math.max(1, Math.round((entry.until - now) / 60000));
  if (minutes < 60) return `还有 ${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `还有 ${hours} 小时`;
  return `还有 ${Math.round(hours / 24)} 天`;
}
