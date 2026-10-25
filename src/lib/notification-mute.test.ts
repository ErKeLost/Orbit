import { beforeEach, describe, expect, it, vi } from "vitest";

// happy-dom 提供一个可用的 localStorage；这里只用它的读写。
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
});

import {
  isProjectMuted,
  muteOptionFor,
  muteOptions,
  muteProject,
  muteRemainingLabel,
  pruneMuted,
  unmuteProject,
} from "./notification-mute";

const now = 1_700_000_000_000;
const project = "/work/pi-gui";

beforeEach(() => {
  store.clear();
  unmuteProject(project);
});

describe("notification mute", () => {
  it("默认不静音", () => {
    expect(isProjectMuted(project, now)).toBe(false);
    expect(muteOptionFor(undefined, now)).toBe("off");
  });

  it("静音一段时间，到点自己失效", () => {
    muteProject(project, now + 60 * 60 * 1000);
    expect(isProjectMuted(project, now)).toBe(true);
    expect(isProjectMuted(project, now + 60 * 60 * 1000 + 1)).toBe(false);
    expect(muteOptionFor({ until: now + 60 * 60 * 1000 }, now)).toBe("1h");
    expect(muteRemainingLabel({ until: now + 60 * 60 * 1000 }, now)).toBe("还有 1 小时");
  });

  it("一直静音没有到期时间", () => {
    muteProject(project, null);
    expect(isProjectMuted(project, now)).toBe(true);
    expect(isProjectMuted(project, now + 10 * 365 * 24 * 60 * 60 * 1000)).toBe(true);
    expect(muteOptionFor({ until: null }, now)).toBe("forever");
    expect(muteRemainingLabel({ until: null }, now)).toBe("一直静音");
  });

  it("只影响被静音的那个项目", () => {
    muteProject(project, null);
    expect(isProjectMuted("/work/other", now)).toBe(false);
  });

  it("过期条目会被清掉，不留僵尸开关", () => {
    muteProject(project, now + 1000);
    pruneMuted(now + 2000);
    expect(isProjectMuted(project, now + 2000)).toBe(false);
    expect(JSON.parse(store.get("orbit.notifyMuted.v1") ?? "{}")).toEqual({});
  });

  it("选项里的「今天」落在今天结束", () => {
    const today = muteOptions(now).find(option => option.value === "today");
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    expect(today?.until).toBe(end.getTime());
  });
});
