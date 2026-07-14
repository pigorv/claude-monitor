import { useState } from "preact/hooks";
import { html } from "htm/preact";
import { downloadSessionExport } from "../api/client";
import { Modal } from "./Modal";

interface ExportButtonProps {
  sessionId: string;
  // Test seam: initialize the modal-open state so SSR can render it open.
  defaultModalOpen?: boolean;
}

export function ExportButton({ sessionId, defaultModalOpen }: ExportButtonProps) {
  const [open, setOpen] = useState(defaultModalOpen ?? false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runDownload(raw: boolean) {
    setError(null);
    setPending(true);
    try {
      await downloadSessionExport(sessionId, { raw });
    } catch (e: any) {
      setError(e?.message || "Export failed");
    } finally {
      setPending(false);
    }
  }

  function selectMode(raw: boolean) {
    void runDownload(raw);
    setOpen(false);
  }

  return html`
    <button
      class="export-btn-header"
      type="button"
      onClick=${() => setOpen(true)}
      disabled=${pending}
      title=${error ?? undefined}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="flex-shrink:0"><path d="M6 1.5V7.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/><path d="M3.5 5L6 7.5L8.5 5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 9.5H10" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>
      Export
    </button>
    <${Modal}
      open=${open}
      onClose=${() => setOpen(false)}
      title="Export session"
      subtitle="Choose what to include in the download."
      footnote="Selecting a row starts that download immediately and closes this dialog."
    >
      <button class="export-row sanitized" type="button" onClick=${() => selectMode(false)}>
        <div class="export-row-icon">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M8 1.5L13.5 4V8C13.5 11.5 11 13.5 8 14.5C5 13.5 2.5 11.5 2.5 8V4L8 1.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M5.5 8L7.2 9.7L10.5 6.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <div class="export-row-text">
          <div class="export-row-title">Sanitized <span class="export-row-badge">Recommended</span></div>
          <div class="export-row-desc">Paths and content scrambled beyond recognition — unreadable, but structure is intact. Safe to share anywhere.</div>
        </div>
        <svg class="export-row-chevron" width="14" height="14" viewBox="0 0 12 12" fill="none"><path d="M4.5 2.5L7.5 6L4.5 9.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="modal-divider"></div>
      <button class="export-row raw" type="button" onClick=${() => selectMode(true)}>
        <div class="export-row-icon">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M8 2V9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="12.5" r="0.9" fill="currentColor"/></svg>
        </div>
        <div class="export-row-text">
          <div class="export-row-title">Raw <span class="export-row-badge">Unsanitized</span></div>
          <div class="export-row-desc">Verbatim paths and content — only share with people you trust.</div>
        </div>
        <svg class="export-row-chevron" width="14" height="14" viewBox="0 0 12 12" fill="none"><path d="M4.5 2.5L7.5 6L4.5 9.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </${Modal}>
  `;
}
