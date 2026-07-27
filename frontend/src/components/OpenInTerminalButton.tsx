import { useState, useEffect } from "preact/hooks";
import { html } from "htm/preact";
import { openTerminal, getPlatform, type TerminalPreference } from "../api/client";

export function OpenInTerminalButton({ sessionId, projectPath, defaultError }: { sessionId: string; projectPath?: string; defaultError?: string | null }) {
  const [state, setState] = useState<"idle" | "launching" | "opened">("idle");
  const [error, setError] = useState<string | null>(defaultError ?? null);
  const [platform, setPlatform] = useState<string | null>(null);

  useEffect(() => {
    getPlatform().then(setPlatform);
  }, []);

  const platformSupported = platform == null || platform === "darwin" || platform === "win32";
  const disabled = !projectPath || state === "launching" || !platformSupported;

  const handleClick = async () => {
    if (disabled) return;
    setError(null);
    setState("launching");
    const pref = (localStorage.getItem("claude-monitor-terminal") as TerminalPreference | null) || "auto";
    try {
      await openTerminal(sessionId, pref);
      setState("opened");
      setTimeout(() => setState("idle"), 1500);
    } catch (e: any) {
      setError(e?.message || "Failed to open terminal");
      setState("idle");
    }
  };

  const title = !projectPath
    ? "No project directory recorded for this session"
    : !platformSupported
    ? "Open in Terminal is not supported on this platform yet"
    : error
    ? error
    : "Open in Terminal";

  return html`
    <span class="terminal-btn-wrap">
      <button
        class="copy-btn"
        onClick=${handleClick}
        disabled=${disabled}
        title=${title}
      >
        ${state === "launching" ? "Launching…" : state === "opened" ? "Opened ✓" : html`
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="flex-shrink:0"><rect x="1" y="2" width="10" height="8" rx="1.2" stroke="currentColor" stroke-width="1.1"/><path d="M3 5L5 6.5L3 8" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.5 8H8.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>
          Open in Terminal
        `}
      </button>
      ${error && html`<span class="terminal-error" role="alert">${error}</span>`}
    </span>
  `;
}
