import { useState, useEffect } from "preact/hooks";
import { html } from "htm/preact";
import { fetchApi } from "../api/client";
import type { HealthResponse } from "../../../src/shared/types";
import "../styles/settings.css";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "\u2014";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type TerminalPref = "auto" | "terminal" | "iterm2" | "wt" | "powershell" | "cmd";

const VALID_TERMINAL_PREFS: ReadonlySet<TerminalPref> = new Set<TerminalPref>([
  "auto",
  "terminal",
  "iterm2",
  "wt",
  "powershell",
  "cmd",
]);

function readTerminalPref(): TerminalPref {
  const v = localStorage.getItem("claude-monitor-terminal");
  return v != null && VALID_TERMINAL_PREFS.has(v as TerminalPref)
    ? (v as TerminalPref)
    : "auto";
}

interface TerminalOption {
  value: TerminalPref;
  label: string;
}

function optionsForPlatform(platform: string | undefined): TerminalOption[] {
  if (platform === "darwin") {
    return [
      { value: "auto", label: "Auto-detect" },
      { value: "terminal", label: "Terminal.app" },
      { value: "iterm2", label: "iTerm2" },
    ];
  }
  if (platform === "win32") {
    return [
      { value: "auto", label: "Auto-detect" },
      { value: "wt", label: "Windows Terminal" },
      { value: "powershell", label: "PowerShell" },
      { value: "cmd", label: "cmd.exe" },
    ];
  }
  return [{ value: "auto", label: "Auto-detect" }];
}

function hintForPlatform(platform: string | undefined): string {
  if (platform === "darwin") {
    return 'Used by the "Open in Terminal" button on session pages. Auto-detect checks $TERM_PROGRAM, falls back to iTerm2 if installed, otherwise Terminal.app.';
  }
  if (platform === "win32") {
    return 'Used by the "Open in Terminal" button on session pages. Auto-detect prefers Windows Terminal (wt.exe) if installed, then PowerShell, then cmd.exe.';
  }
  return 'The "Open in Terminal" button isn\'t supported on this platform yet.';
}

export function Settings() {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [terminalPref, setTerminalPref] = useState<TerminalPref>(readTerminalPref());

  const load = () => {
    fetchApi<HealthResponse>("/api/health")
      .then(setData)
      .catch((e) => setError(e.message));
  };

  useEffect(load, []);

  const handleReimport = async () => {
    setImporting(true);
    setImportResult(null);
    try {
      const res = await fetch("/api/reimport", { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      const body = await res.json();
      setImportResult(`Imported ${body.imported ?? 0} sessions`);
      load();
    } catch (e: any) {
      setImportResult(`Error: ${e.message}`);
    } finally {
      setImporting(false);
    }
  };

  const handleExport = () => {
    window.open("/api/export", "_blank");
  };

  const handleTerminalChange = (e: Event) => {
    const value = (e.target as HTMLSelectElement).value as TerminalPref;
    setTerminalPref(value);
    localStorage.setItem("claude-monitor-terminal", value);
  };

  const handleClear = async () => {
    if (!clearConfirm) {
      setClearConfirm(true);
      return;
    }
    setClearing(true);
    try {
      const res = await fetch("/api/clear?confirm=true", { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      setImportResult("Database cleared");
      setClearConfirm(false);
      load();
    } catch (e: any) {
      setImportResult(`Error: ${e.message}`);
    } finally {
      setClearing(false);
    }
  };

  if (error) {
    return html`
      <div class="page">
        <h1>Settings</h1>
        <div class="settings-error">
          Failed to load: ${error}. Is the server running?
        </div>
      </div>
    `;
  }

  if (!data) {
    return html`
      <div class="page">
        <h1>Settings</h1>
        <p class="page-sub">Loading...</p>
      </div>
    `;
  }

  return html`
    <div class="page">
      <h1>Settings</h1>
      <p class="page-sub">Database management and tool info</p>

      <div class="settings-grid">
        <!-- Database card with export and clear -->
        <section class="settings-card">
          <h3>Database</h3>
          <div class="settings-rows">
            <div class="settings-row">
              <span class="settings-label">Path</span>
              <span class="settings-value mono">${data.db_path || "\u2014"}</span>
            </div>
            <div class="settings-row">
              <span class="settings-label">Size</span>
              <span class="settings-value">${formatBytes(data.db_size_bytes)}</span>
            </div>
            <div class="settings-row">
              <span class="settings-label">Sessions</span>
              <span class="settings-value">${data.session_count}</span>
            </div>
            <div class="settings-row">
              <span class="settings-label">Events</span>
              <span class="settings-value">${data.event_count}</span>
            </div>
            <div class="settings-row">
              <span class="settings-label">Oldest session</span>
              <span class="settings-value">${formatDate(data.oldest_session)}</span>
            </div>
            <div class="settings-row">
              <span class="settings-label">Newest session</span>
              <span class="settings-value">${formatDate(data.newest_session)}</span>
            </div>
          </div>
          <div class="settings-actions">
            <button
              class="btn"
              onClick=${handleReimport}
              disabled=${importing}
            >
              ${importing ? "Importing\u2026" : "Re-import"}
            </button>
            <button class="btn btn-secondary" onClick=${handleExport}>
              Export .sqlite
            </button>
            <button
              class="btn btn-danger"
              onClick=${handleClear}
              disabled=${clearing}
            >
              ${clearConfirm ? "Confirm clear?" : "Clear database"}
            </button>
          </div>
          ${importResult
            ? html`<p class="settings-hint">${importResult}</p>`
            : null}
        </section>

        <!-- About card -->
        <section class="settings-card">
          <h3>About</h3>
          <div class="settings-rows">
            <div class="settings-row">
              <span class="settings-label">Version</span>
              <span class="settings-value">v${data.version}</span>
            </div>
            <div class="settings-row">
              <span class="settings-label">Node.js</span>
              <span class="settings-value mono">${data.node_version || "\u2014"}</span>
            </div>
            <div class="settings-row">
              <span class="settings-label">DB engine</span>
              <span class="settings-value">${data.db_engine || "SQLite"}</span>
            </div>
            <div class="settings-row">
              <span class="settings-label">Server</span>
              <span class="settings-value">
                Hono · <span class="status-dot dot-ok"></span> Running
              </span>
            </div>
            <div class="settings-row">
              <span class="settings-label">Port</span>
              <span class="settings-value mono">${data.server_port || "\u2014"}</span>
            </div>
          </div>
        </section>

        <!-- Terminal card -->
        ${(() => {
          const options = optionsForPlatform(data.platform);
          // Show 'auto' in the dropdown if the stored pref doesn't match the
          // current platform — don't overwrite localStorage so a pref from
          // another machine survives a round-trip.
          const displayPref = options.some((o) => o.value === terminalPref)
            ? terminalPref
            : "auto";
          return html`
            <section class="settings-card">
              <h3>Terminal</h3>
              <div class="settings-rows">
                <div class="settings-row">
                  <span class="settings-label">Preferred app</span>
                  <select
                    class="terminal-select"
                    value=${displayPref}
                    onChange=${handleTerminalChange}
                    disabled=${options.length <= 1}
                  >
                    ${options.map(
                      (o) => html`<option value=${o.value}>${o.label}</option>`,
                    )}
                  </select>
                </div>
              </div>
              <p class="settings-hint">${hintForPlatform(data.platform)}</p>
            </section>
          `;
        })()}

        <!-- Quick Actions card -->
        <section class="settings-card">
          <h3>Quick Actions</h3>
          <div class="quick-actions">
            <button class="action-btn" onClick=${handleExport}>
              Open DB viewer
            </button>
            <button class="action-btn" onClick=${load}>
              Check for updates
            </button>
          </div>
        </section>
      </div>
    </div>
  `;
}
