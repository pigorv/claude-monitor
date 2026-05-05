// Hash-based URL state helpers.
//
// Routes look like `#/path?key=value&key2=value2`. The leading `#` is stripped,
// then the hash is split on its first `?` into a path and a query string.

export interface ParsedHash {
  path: string;
  params: URLSearchParams;
}

export function parseHash(hash: string): ParsedHash {
  let raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) raw = "/";
  const qIndex = raw.indexOf("?");
  if (qIndex < 0) return { path: raw, params: new URLSearchParams() };
  const path = raw.slice(0, qIndex) || "/";
  const params = new URLSearchParams(raw.slice(qIndex + 1));
  return { path, params };
}

export function buildHash(path: string, params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `#${path}?${qs}` : `#${path}`;
}

// Merge `updates` into the current hash's query string and write the result via
// `history.pushState` or `history.replaceState`. A `null` value deletes the key.
//
// `history.*State` does not fire `hashchange`, so we dispatch one manually so
// `useRoute` (and any other listeners) re-run.
export function updateParams(
  updates: Record<string, string | null | undefined>,
  mode: "push" | "replace" = "replace",
): void {
  const { path, params } = parseHash(location.hash);
  for (const [key, value] of Object.entries(updates)) {
    if (value == null || value === "") {
      params.delete(key);
    } else {
      params.set(key, value);
    }
  }
  const next = buildHash(path, params);
  if (next === location.hash) return;
  const url = location.pathname + location.search + next;
  try {
    if (mode === "push") history.pushState(null, "", url);
    else history.replaceState(null, "", url);
  } catch {
    location.hash = next;
    return;
  }
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}
