import { useState, useEffect, useRef } from "preact/hooks";
import { html } from "htm/preact";

export interface DropdownOption {
  value: string;
  label: string;
  swatch?: string;
  trailing?: string | number;
}

interface DropdownProps {
  label: string;
  options: DropdownOption[];
  value: string;
  onChange: (v: string) => void;
  triggerSwatch?: string;
  typeahead?: boolean;
  defaultOpen?: boolean;
  class?: string;
}

export function Dropdown(props: DropdownProps) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [open]);

  useEffect(() => {
    if (open && props.typeahead && searchRef.current) {
      searchRef.current.focus();
    }
  }, [open, props.typeahead]);

  function toggle() {
    setOpen((v) => {
      if (v) setQuery("");
      return !v;
    });
  }

  function select(value: string) {
    props.onChange(value);
    setOpen(false);
    setQuery("");
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
    }
  }

  const filtered =
    props.typeahead && query
      ? props.options.filter((o) =>
          o.label.toLowerCase().includes(query.toLowerCase())
        )
      : props.options;

  return html`
    <div
      class=${`dd-root${open ? " dd-open" : ""}${props.class ? " " + props.class : ""}`}
      ref=${rootRef}
      onKeyDown=${handleKeyDown}
    >
      <button class="dd-trigger" type="button" onClick=${toggle}>
        ${props.triggerSwatch &&
          html`<span class="dd-swatch" style=${`background:${props.triggerSwatch}`}></span>`}
        <span class="dd-trigger-label">${props.label}</span>
        <span class="dd-caret" aria-hidden="true">▾</span>
      </button>
      ${open &&
        html`
          <div class="dd-popover" role="listbox">
            ${props.typeahead &&
              html`
                <input
                  ref=${searchRef}
                  class="dd-search"
                  type="text"
                  placeholder="Search…"
                  value=${query}
                  onInput=${(e: Event) =>
                    setQuery((e.target as HTMLInputElement).value)}
                />
              `}
            ${filtered.map(
              (opt) => html`
                <div
                  class=${`dd-option${opt.value === props.value ? " dd-option-selected" : ""}`}
                  role="option"
                  aria-selected=${opt.value === props.value}
                  onClick=${() => select(opt.value)}
                >
                  ${opt.swatch &&
                    html`<span
                      class="dd-swatch"
                      style=${`background:${opt.swatch}`}
                    ></span>`}
                  ${opt.label}
                  ${opt.trailing != null &&
                    html`<span class="dd-trailing">${opt.trailing}</span>`}
                </div>
              `
            )}
          </div>
        `}
    </div>
  `;
}
