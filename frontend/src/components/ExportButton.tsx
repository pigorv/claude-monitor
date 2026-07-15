import { useState, useEffect, useRef } from "preact/hooks";
import { html } from "htm/preact";
import { downloadSessionExport } from "../api/client";

interface ExportButtonProps {
  sessionId: string;
  // Test seam: initialize the menu-open state so SSR can render it open.
  defaultMenuOpen?: boolean;
}

type Mode = "idle" | "armed" | "pending";

// Auto-disarm the two-step confirm after this long with no second click.
const ARM_TIMEOUT_MS = 3000;

export function ExportButton({ sessionId, defaultMenuOpen }: ExportButtonProps) {
  const [mode, setMode] = useState<Mode>("idle");
  const [menuOpen, setMenuOpen] = useState(defaultMenuOpen ?? false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearArmTimer() {
    if (armTimer.current != null) {
      clearTimeout(armTimer.current);
      armTimer.current = null;
    }
  }

  // Disarm the primary on outside pointerdown (mirrors Dropdown) — this also
  // covers the menu, which shares the same root and closes on outside click.
  useEffect(() => {
    if (mode !== "armed" && !menuOpen) return;
    const handler = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setMode((m) => (m === "armed" ? "idle" : m));
        setMenuOpen(false);
        clearArmTimer();
      }
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [mode, menuOpen]);

  // The arm timer is owned by the handlers (each disarm site clears it). This
  // effect only guards against a timer outliving the component. It must NOT
  // depend on `mode`: a `[mode]` effect's cleanup runs on the same commit that
  // enters "armed" and would clear the timer handlePrimaryClick just set,
  // silently killing the auto-disarm.
  useEffect(() => clearArmTimer, []);

  async function runDownload(raw: boolean) {
    setError(null);
    clearArmTimer();
    setMode("pending");
    try {
      await downloadSessionExport(sessionId, { raw });
    } catch (e: any) {
      setError(e?.message || "Export failed");
    } finally {
      setMode("idle");
    }
  }

  function handlePrimaryClick() {
    if (mode === "pending") return;
    if (mode === "idle") {
      // First click arms the confirm and schedules an auto-disarm.
      setMode("armed");
      clearArmTimer();
      armTimer.current = setTimeout(() => {
        setMode((m) => (m === "armed" ? "idle" : m));
      }, ARM_TIMEOUT_MS);
      return;
    }
    // armed → second click starts the raw download.
    void runDownload(true);
  }

  function handlePrimaryBlur() {
    // Losing focus disarms the confirm.
    setMode((m) => (m === "armed" ? "idle" : m));
    clearArmTimer();
  }

  function toggleMenu() {
    if (mode === "pending") return;
    // Opening the menu disarms the primary.
    setMode((m) => (m === "armed" ? "idle" : m));
    clearArmTimer();
    setMenuOpen((v) => !v);
  }

  function selectMode(raw: boolean) {
    setMenuOpen(false);
    void runDownload(raw);
  }

  const pending = mode === "pending";
  const primaryLabel =
    mode === "pending" ? "Exporting…" : mode === "armed" ? "Export raw?" : "Export (raw)";
  const primaryTitle = error ? error : "Export this session as a raw (unsanitized) bundle";

  return html`
    <div class="export-btn-root" ref=${rootRef}>
      <button
        class=${`copy-btn export-btn-primary${mode === "armed" ? " export-btn-armed" : ""}`}
        type="button"
        onClick=${handlePrimaryClick}
        onBlur=${handlePrimaryBlur}
        disabled=${pending}
        title=${primaryTitle}
      >
        ${pending
          ? "Exporting…"
          : html`
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="flex-shrink:0"><path d="M6 1.5V7.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/><path d="M3.5 5L6 7.5L8.5 5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 9.5H10" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>
              ${primaryLabel}
            `}
      </button>
      <button
        class="copy-btn export-btn-caret"
        type="button"
        onClick=${toggleMenu}
        disabled=${pending}
        title="Choose export mode"
        aria-label="Choose export mode"
        aria-haspopup="menu"
        aria-expanded=${menuOpen}
      >
        <span aria-hidden="true">▾</span>
      </button>
      ${menuOpen &&
        html`
          <div class="export-btn-menu" role="menu">
            <button
              class="export-btn-option"
              type="button"
              role="menuitem"
              onClick=${() => selectMode(true)}
            >
              Raw (unsanitized)
            </button>
            <button
              class="export-btn-option"
              type="button"
              role="menuitem"
              onClick=${() => selectMode(false)}
            >
              Sanitized
            </button>
          </div>
        `}
    </div>
  `;
}
