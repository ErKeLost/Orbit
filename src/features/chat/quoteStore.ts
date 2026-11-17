import { useSyncExternalStore } from "react";
import type { Quote } from "./quote";

let current: Quote | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function setQuote(quote: Quote | null) {
  current = quote;
  emit();
}

export function getQuote(): Quote | null {
  return current;
}

export function useQuote(): Quote | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getQuote,
    getQuote,
  );
}
