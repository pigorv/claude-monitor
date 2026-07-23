import { useState } from "preact/hooks";
import { html } from "htm/preact";
import { cloneSession } from "../api/client";
import { Modal } from "./Modal";
import { CopyButton } from "./CopyButton";
import { OpenInTerminalButton } from "./OpenInTerminalButton";

interface CloneResult {
  id: string;
  projectPath: string;
}

interface CloneButtonProps {
  sessionId: string;
  projectPath: string;
  // Disabled on Expired sessions — Clone needs the raw transcript on disk.
  disabled?: boolean;
  // Test seams: SSR renders can only exercise the initial render, so these
  // let a test drive the modal open and pre-seed the error / success views
  // (the interactive edit → submit path needs jsdom, which this repo lacks).
  defaultModalOpen?: boolean;
  defaultDir?: string;
  defaultError?: string | null;
  defaultResult?: CloneResult | null;
}

const DISABLED_TOOLTIP =
  "Clone needs this session's raw transcript, which is no longer on disk. Expired sessions can't be cloned.";

export function CloneButton({
  sessionId,
  projectPath,
  disabled,
  defaultModalOpen,
  defaultDir,
  defaultError,
  defaultResult,
}: CloneButtonProps) {
  const [open, setOpen] = useState(defaultModalOpen ?? false);
  const [dir, setDir] = useState(defaultDir ?? projectPath);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(defaultError ?? null);
  const [result, setResult] = useState<CloneResult | null>(defaultResult ?? null);

  function close() {
    setOpen(false);
    // Reset back to a clean slate so reopening starts fresh.
    setDir(projectPath);
    setError(null);
    setResult(null);
    setPending(false);
  }

  async function submit() {
    const targetDir = dir.trim();
    setError(null);
    setPending(true);
    try {
      const res = await cloneSession(sessionId, { targetDir });
      setResult(res);
    } catch (e: any) {
      setError(e?.message || "Clone failed");
    } finally {
      setPending(false);
    }
  }

  const canClone = dir.trim().length > 0 && !pending;

  return html`
    <button
      class="clone-btn-header"
      type="button"
      onClick=${() => setOpen(true)}
      disabled=${disabled}
      title=${disabled ? DISABLED_TOOLTIP : "Clone this session into another directory"}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="flex-shrink:0"><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" stroke="currentColor" stroke-width="1.1"/><path d="M8 4V2.5A1.5 1.5 0 006.5 1H2.5A1.5 1.5 0 001 2.5v4A1.5 1.5 0 002.5 8H4" stroke="currentColor" stroke-width="1.1"/></svg>
      Clone
    </button>
    <${Modal}
      open=${open}
      onClose=${close}
      title="Clone session"
      subtitle=${result
        ? "The session was cloned into a fresh id."
        : "Copy this session's transcript into another directory under a new id."}
    >
      ${result
        ? html`
          <div class="clone-success">
            <div class="clone-field-label">New session</div>
            <div class="resume-cmd">
              <span class="resume-cmd-dollar">$</span>
              <code class="resume-cmd-text">claude --resume ${result.id}</code>
              <${CopyButton} text=${"claude --resume " + result.id} label="Copy" />
            </div>
            <div class="clone-success-actions">
              <${OpenInTerminalButton} sessionId=${result.id} projectPath=${result.projectPath} />
              <a class="clone-open-link" href=${"#/session/" + result.id} onClick=${close}>Open cloned session →</a>
            </div>
          </div>
        `
        : html`
          <label class="clone-field-label" for="clone-target-dir">Target directory</label>
          <input
            id="clone-target-dir"
            class="clone-input"
            type="text"
            value=${dir}
            spellcheck=${false}
            placeholder="/absolute/path/to/directory"
            onInput=${(e: any) => setDir(e.currentTarget.value)}
          />
          <div class="clone-field-hint">
            <span>The cloned session opens in this directory.</span>
            <button
              class="clone-reset-btn"
              type="button"
              onClick=${() => setDir(projectPath)}
              disabled=${dir === projectPath}
            >
              Use recorded path
            </button>
          </div>
          ${error && html`<div class="clone-error" role="alert">${error}</div>`}
          <button
            class="clone-submit-btn"
            type="button"
            onClick=${submit}
            disabled=${!canClone}
          >
            ${pending ? "Cloning…" : "Clone"}
          </button>
        `}
    </${Modal}>
  `;
}
