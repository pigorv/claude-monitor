// One-shot migration from the previous `cm:projectFilter` key to
// `cm.sessionList.project`. Idempotent: clears the old key once seen.
export function migrateProjectFilterKey(): void {
  try {
    const old = localStorage.getItem("cm:projectFilter");
    const NEW_KEY = "cm.sessionList.project";
    if (old != null && localStorage.getItem(NEW_KEY) == null) {
      localStorage.setItem(NEW_KEY, JSON.stringify(old));
    }
    if (old != null) localStorage.removeItem("cm:projectFilter");
  } catch {}
}
