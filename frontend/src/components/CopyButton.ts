import { useState } from "preact/hooks";
import { html } from "htm/preact";

/**
 * Small button that copies `text` to the clipboard. Shows a transient
 * "Copied!" on success or "Failed" if the clipboard API rejects — the
 * latter happens on non-secure origins (e.g. LAN-IP access), where a
 * silent no-op would leave the user with no feedback.
 */
export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  const handleCopy = (e: globalThis.Event) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(
      () => {
        setState("copied");
        setTimeout(() => setState("idle"), 1500);
      },
      () => {
        setState("failed");
        setTimeout(() => setState("idle"), 1500);
      },
    );
  };

  return html`
    <button class="copy-btn" onClick=${handleCopy} title="Copy to clipboard">
      ${state === "copied" ? "Copied!" : state === "failed" ? "Failed" : html`
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="flex-shrink:0"><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" stroke="currentColor" stroke-width="1.1"/><path d="M8 4V2.5A1.5 1.5 0 006.5 1H2.5A1.5 1.5 0 001 2.5v4A1.5 1.5 0 002.5 8H4" stroke="currentColor" stroke-width="1.1"/></svg>
        ${label || "Copy"}
      `}
    </button>
  `;
}
