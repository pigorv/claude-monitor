import { useState, useEffect } from "preact/hooks";
import { html } from "htm/preact";
import { fetchApi } from "../api/client";
import type { HealthResponse, HookStatus } from "../../../src/shared/types";
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

const HOOK_LABELS: Record<string, string> = {
  SessionStart: "SessionStart",
  SessionEnd: "SessionEnd",
  PreToolUse: "PreToolUse",
  PostToolUse: "PostToolUse",
  SubagentStart: "SubagentStart",
  SubagentStop: "SubagentStop",
  PreCompact: "PreCompact",
};

export function Settings() {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);

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

  const hooks = data.hooks || {};
  const settingsPath = "~/.claude/settings.local.json";

  return html`
    <div class="page">
      <h1>Settings</h1>
      <p class="page-sub">Hook configuration, database management, and tool info</p>

      <div class="settings-grid">
        <!-- 8.1: Hook Status with per-hook indicators -->
        <section class="settings-card">
          <h3>Hook configuration</h3>
          <p class="settings-file-path">Configured in <code>${settingsPath}</code></p>
          <div class="hook-list">
            ${Object.entries(HOOK_LABELS).map(
              ([key, label]) => {
                const status: HookStatus | undefined = hooks[key];
                const active = status?.configured && status?.script_exists;
                return html`
                  <div class="hook-row">
                    <span class="hook-dot ${active ? "hook-active" : "hook-missing"}"></span>
                    <span class="hook-name">${label}</span>
                    <span class="hook-status ${active ? "hook-active" : "hook-missing"}">
                      ${active ? "active" : "missing"}
                    </span>
                  </div>
                `;
              }
            )}
          </div>
          ${!data.hooks_configured
            ? html`
                <p class="settings-hint">
                  Run <code>claude-monitor setup</code> to configure hooks.
                </p>
              `
            : null}
        </section>

        <!-- 8.2: Database card with export and clear -->
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

        <!-- 8.3: About card -->
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

        <!-- 8.4: Quick Actions card -->
        <section class="settings-card">
          <h3>Quick Actions</h3>
          <div class="quick-actions">
            <button class="action-btn" onClick=${() => { handleReimport(); }}>
              Reconfigure hooks
            </button>
            <button class="action-btn" onClick=${handleExport}>
              Open DB viewer
            </button>
            <button class="action-btn" onClick=${() => window.open("/api/export", "_blank")}>
              View events.jsonl
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
