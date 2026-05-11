/**
 * Simple markdown-to-HTML renderer. No dependencies.
 * Escapes HTML first, then applies markdown transformations.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Tags Claude emits in transcripts that we want to preserve as styled blocks.
const PRESERVED_TAGS = ['system-reminder', 'example'] as const;
type PreservedTag = (typeof PRESERVED_TAGS)[number];
const PRESERVED_TAG_RE = new RegExp(
  `<(${PRESERVED_TAGS.join('|')})>([\\s\\S]*?)</\\1>`,
  'g',
);

export function renderMarkdown(text: string): string {
  if (!text) return '';

  // Extract preserved tag blocks first (before any escaping) so their inner
  // content can be rendered recursively and the tag itself can be shown as a
  // styled label rather than escaped angle brackets.
  const taggedBlocks: { tag: PreservedTag; inner: string }[] = [];
  let result = text.replace(PRESERVED_TAG_RE, (_match, tag: PreservedTag, inner: string) => {
    const idx = taggedBlocks.length;
    taggedBlocks.push({ tag, inner: inner.trim() });
    return `\x00TB${idx}\x00`;
  });

  // Extract code blocks (protect from other transformations)
  const codeBlocks: string[] = [];
  result = result.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre class="md-code-block"><code>${escapeHtml(code.trimEnd())}</code></pre>`);
    return `\x00CB${idx}\x00`;
  });

  // Extract inline code (protect from other transformations)
  const inlineCode: string[] = [];
  result = result.replace(/`([^`\n]+)`/g, (_match, code) => {
    const idx = inlineCode.length;
    inlineCode.push(`<code class="md-inline-code">${escapeHtml(code)}</code>`);
    return `\x00IC${idx}\x00`;
  });

  // Escape HTML in remaining text
  result = escapeHtml(result);

  // Headers
  result = result.replace(/^### (.+)$/gm, '<h5>$1</h5>');
  result = result.replace(/^## (.+)$/gm, '<h4>$1</h4>');
  result = result.replace(/^# (.+)$/gm, '<h3>$1</h3>');

  // Bold and italic
  result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Unordered lists (consecutive lines starting with - )
  result = result.replace(/(?:^|\n)((?:- .+\n?)+)/g, (_match, block: string) => {
    const items = block.trim().split('\n').map((line: string) =>
      `<li>${line.replace(/^- /, '')}</li>`
    ).join('');
    return `\n<ul>${items}</ul>\n`;
  });

  // Ordered lists (consecutive lines starting with number. )
  result = result.replace(/(?:^|\n)((?:\d+\. .+\n?)+)/g, (_match, block: string) => {
    const items = block.trim().split('\n').map((line: string) =>
      `<li>${line.replace(/^\d+\. /, '')}</li>`
    ).join('');
    return `\n<ol>${items}</ol>\n`;
  });

  // Blockquotes (consecutive lines starting with > — escaped to &gt; by this point)
  result = result.replace(/(?:^|\n)((?:&gt; ?.*(?:\n|$))+)/g, (_match, block: string) => {
    const lines = block.replace(/\n$/, '').split('\n').map((line: string) =>
      line.replace(/^&gt; ?/, '')
    );
    return `\n<blockquote class="md-blockquote">${lines.join('<br>')}</blockquote>\n`;
  });

  // Links
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Paragraphs (double newline)
  result = result.replace(/\n\n+/g, '</p><p>');
  result = `<p>${result}</p>`;

  // Clean up empty paragraphs and unwrap block elements
  result = result.replace(/<p>\s*<\/p>/g, '');
  result = result.replace(/<p>\s*(<h[345]>)/g, '$1');
  result = result.replace(/(<\/h[345]>)\s*<\/p>/g, '$1');
  result = result.replace(/<p>\s*(<ul>)/g, '$1');
  result = result.replace(/(<\/ul>)\s*<\/p>/g, '$1');
  result = result.replace(/<p>\s*(<ol>)/g, '$1');
  result = result.replace(/(<\/ol>)\s*<\/p>/g, '$1');
  result = result.replace(/<p>\s*(<pre)/g, '$1');
  result = result.replace(/(<\/pre>)\s*<\/p>/g, '$1');
  result = result.replace(/<p>\s*(<blockquote)/g, '$1');
  result = result.replace(/(<\/blockquote>)\s*<\/p>/g, '$1');

  // Single newlines → <br>
  result = result.replace(/\n/g, '<br>');

  // Restore code blocks and inline code
  result = result.replace(/\x00CB(\d+)\x00/g, (_match, idx) => codeBlocks[parseInt(idx)]);
  result = result.replace(/\x00IC(\d+)\x00/g, (_match, idx) => inlineCode[parseInt(idx)]);

  // Render and restore tagged blocks last so nested preserved-tags inside the
  // inner content get their own independent placeholder lifecycle.
  result = result.replace(/\x00TB(\d+)\x00/g, (_match, idx) => {
    const block = taggedBlocks[parseInt(idx)];
    if (!block) return '';
    return renderTaggedBlock(block.tag, renderMarkdown(block.inner));
  });

  // A tagged-block placeholder that ended up wrapped alone in a paragraph
  // reads awkwardly; strip the wrapping <p> in that case.
  result = result.replace(
    /<p>(<div class="md-tagged-block[\s\S]*?<\/div>)<\/p>/g,
    '$1',
  );

  return result;
}

function renderTaggedBlock(tag: PreservedTag, innerHtml: string): string {
  return (
    `<div class="md-tagged-block md-tag-${tag}">` +
    `<span class="md-tag-label">&lt;${tag}&gt;</span>` +
    `<div class="md-tagged-body">${innerHtml}</div>` +
    `<span class="md-tag-label md-tag-label-close">&lt;/${tag}&gt;</span>` +
    `</div>`
  );
}

export type ContentFormat = 'json' | 'markdown' | 'plain';

const MARKDOWN_PATTERNS: RegExp[] = [
  /```/,                        // fenced code block
  /^#{1,3} /m,                  // heading
  /\*\*[^*\n]+\*\*/,            // bold
  /<system-reminder>/,          // preserved tag
  /<example>/,                  // preserved tag
  /(?:^|\n)> /,                 // blockquote
];

export function detectFormat(text: string): ContentFormat {
  if (!text) return 'plain';
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(text.trim());
      return 'json';
    } catch {
      // not JSON, fall through to other heuristics
    }
  }
  for (const re of MARKDOWN_PATTERNS) {
    if (re.test(text)) return 'markdown';
  }
  const bulletMatches = text.match(/(?:^|\n)[-*] .+/g);
  if (bulletMatches && bulletMatches.length >= 2) return 'markdown';
  const numberedMatches = text.match(/(?:^|\n)\d+\. .+/g);
  if (numberedMatches && numberedMatches.length >= 2) return 'markdown';
  return 'plain';
}

export function renderJson(text: string): string {
  try {
    const pretty = JSON.stringify(JSON.parse(text.trim()), null, 2);
    return `<pre class="detail-content json-block">${escapeHtml(pretty)}</pre>`;
  } catch {
    return `<pre class="detail-content">${escapeHtml(text)}</pre>`;
  }
}

/**
 * Format-aware rendering that returns ONLY the inner HTML — no wrapping
 * `<pre>` or `<div>`. Use this when the caller already owns a styled container
 * (e.g. `.agent-event-body`, `.agent-tool-io-content`, `.tool-detail-content`)
 * and just wants the content rendered correctly inside it. For fresh detail
 * panes use the `StructuredContent` Preact component instead.
 *
 * The caller is responsible for injecting the result via
 * `dangerouslySetInnerHTML`. Output is always HTML-escaped; markdown output
 * may contain block elements (`<p>`, `<ul>`, `<h3>`, …), so don't drop this
 * into a `<span>`.
 */
export function renderStructuredInner(text: string, hint?: ContentFormat): string {
  if (!text) return '';
  const format = hint ?? detectFormat(text);
  if (format === 'json') {
    try {
      return escapeHtml(JSON.stringify(JSON.parse(text.trim()), null, 2));
    } catch {
      // fall through to plain
    }
  }
  if (format === 'markdown') {
    // Wrap in `.md-rendered` so markdown typography (sans font, headings,
    // lists, code chips, tagged blocks) applies regardless of which container
    // the caller drops this into.
    return `<div class="md-rendered">${renderMarkdown(text)}</div>`;
  }
  return escapeHtml(text);
}
