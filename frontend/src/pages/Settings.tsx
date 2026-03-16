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
