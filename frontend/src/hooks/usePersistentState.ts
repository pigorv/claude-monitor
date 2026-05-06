import { useState, useCallback } from "preact/hooks";

// useState-like hook that mirrors the value into localStorage under `key`.
// On parse failure or storage errors, it falls back to `defaultValue` and
// clears the bad entry so the page never crashes on a corrupt value.
export function usePersistentState<T>(
  key: string,
  defaultValue: T,
): [T, (next: T) => void] {
  const [value, setValueState] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return defaultValue;
      return JSON.parse(raw) as T;
    } catch {
      try { localStorage.removeItem(key); } catch {}
      return defaultValue;
    }
  });

  const setValue = useCallback((next: T) => {
    setValueState(next);
    try {
      if (next == null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(next));
    } catch {}
  }, [key]);

  return [value, setValue];
}
