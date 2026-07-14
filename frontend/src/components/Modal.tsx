import { useEffect, useRef } from "preact/hooks";
import { html } from "htm/preact";
import type { ComponentChildren } from "preact";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  titleId?: string;
  footnote?: string;
  children?: ComponentChildren;
}

export function Modal(props: ModalProps) {
  const { open, onClose, title, subtitle, footnote } = props;
  const titleId = props.titleId ?? "modal-title";
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  useEffect(() => {
    if (open && modalRef.current) {
      modalRef.current.focus();
    }
  }, [open]);

  if (!open) return null;

  function onOverlayPointerDown(e: PointerEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  return html`
    <div class="modal-overlay" onPointerDown=${onOverlayPointerDown}>
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby=${titleId}
        tabindex="-1"
        ref=${modalRef}
      >
        <div class="modal-header">
          <div>
            <div class="modal-title" id=${titleId}>${title}</div>
            ${subtitle && html`<div class="modal-sub">${subtitle}</div>`}
          </div>
          <button
            class="modal-close"
            type="button"
            aria-label="Close"
            onClick=${onClose}
          >
            ✕
          </button>
        </div>
        <div class="modal-body">${props.children}</div>
        ${footnote && html`<div class="modal-footnote">${footnote}</div>`}
      </div>
    </div>
  `;
}
