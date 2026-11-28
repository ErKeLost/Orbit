import { useSyncExternalStore } from "react";
import type { Session } from "../../../lib/protocol";

const sectionNames = ["今天", "昨天", "最近 7 天", "更早"] as const;

type SessionSection<Entry> = { id: string; label: (typeof sectionNames)[number]; items: Entry[] };

export function dayStart(time = Date.now(), offset = 0): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return date.getTime();
}

export function groupSessionsByDay<Entry extends { session: Pick<Session, "modified"> }>(entries: readonly Entry[], today: number): SessionSection<Entry>[] {
  const yesterday = dayStart(today, -1);
  const weekStart = dayStart(today, -6);
  const sections: SessionSection<Entry>[] = sectionNames.map((label, index) => ({
    id: ["today", "yesterday", "week", "older"][index], label, items: [],
  }));
  for (const entry of entries) {
    const updated = Date.parse(entry.session.modified);
    const index = updated >= today ? 0 : updated >= yesterday ? 1 : updated >= weekStart ? 2 : 3;
    sections[index].items.push(entry);
  }
  return sections.filter(section => section.items.length > 0);
}

const getToday = () => dayStart();

/** Calendar groups update at local midnight and when the app wakes from sleep. */
function subscribeToDay(update: () => void) {
  let timer: ReturnType<typeof setTimeout>;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(schedule, Math.max(1, dayStart(Date.now(), 1) - Date.now()));
    update();
  }
  schedule();
  window.addEventListener("focus", schedule);
  document.addEventListener("visibilitychange", schedule);
  return () => {
    clearTimeout(timer);
    window.removeEventListener("focus", schedule);
    document.removeEventListener("visibilitychange", schedule);
  };
}

export function useSessionDay() {
  return useSyncExternalStore(subscribeToDay, getToday, getToday);
}
