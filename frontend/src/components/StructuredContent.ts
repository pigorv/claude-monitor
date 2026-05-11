import { html } from "htm/preact";
import {
  detectFormat,
  renderMarkdown,
  renderStructuredInner,
  type ContentFormat,
} from "../lib/markdown";

interface StructuredContentProps {
  text: string | null | undefined;
  hint?: ContentFormat;
}

/**
 * Renders text in a NEW detail pane using the appropriate formatter:
 *  - hint="json"     → pretty-printed JSON in `<pre class="detail-content json-block">`
 *  - hint="markdown" → `renderMarkdown()` in `<div class="detail-content markdown-content">`
 *  - hint="plain" or no hint → auto-detect via `detectFormat()`
 *
 * Bad JSON silently falls through to plain rendering so a bogus hint can't
 * blank out a detail pane.
 *
 * For surfaces that already own a styled container (e.g. agent-tool-io-content,
 * agent-event-body, tool-detail-content), use `renderStructuredInner` from
 * `lib/markdown` directly via `dangerouslySetInnerHTML` to avoid nesting.
 */
export function StructuredContent({ text, hint }: StructuredContentProps) {
  if (text == null || text === "") return null;

  const format: ContentFormat = hint ?? detectFormat(text);

  if (format === "json") {
    try {
      const pretty = JSON.stringify(JSON.parse(text.trim()), null, 2);
      return html`<pre class="detail-content json-block">${pretty}</pre>`;
    } catch {
      // fall through to plain
    }
  }

  if (format === "markdown") {
    return html`<div
      class="detail-content markdown-content"
      dangerouslySetInnerHTML=${{ __html: renderMarkdown(text) }}
    />`;
  }

  return html`<pre class="detail-content">${text}</pre>`;
}

// Re-exports so consumers only need to import from this module.
export { renderStructuredInner } from "../lib/markdown";
