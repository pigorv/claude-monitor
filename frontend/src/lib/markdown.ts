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

export function renderMarkdown(text: string): string {
  if (!text) return '';

  // Extract code blocks first (protect from other transformations)
  const codeBlocks: string[] = [];
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang, code) => {
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

  // Links
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Paragraphs (double newline)
  result = result.replace(/\n\n+/g, '</p><p>');
  result = `<p>${result}</p>`;

  // Clean up empty paragraphs
  result = result.replace(/<p>\s*<\/p>/g, '');
  result = result.replace(/<p>\s*(<h[345]>)/g, '$1');
  result = result.replace(/(<\/h[345]>)\s*<\/p>/g, '$1');
  result = result.replace(/<p>\s*(<ul>)/g, '$1');
  result = result.replace(/(<\/ul>)\s*<\/p>/g, '$1');
  result = result.replace(/<p>\s*(<ol>)/g, '$1');
  result = result.replace(/(<\/ol>)\s*<\/p>/g, '$1');
  result = result.replace(/<p>\s*(<pre)/g, '$1');
  result = result.replace(/(<\/pre>)\s*<\/p>/g, '$1');

  // Single newlines → <br>
  result = result.replace(/\n/g, '<br>');

  // Restore code blocks and inline code
  result = result.replace(/\x00CB(\d+)\x00/g, (_match, idx) => codeBlocks[parseInt(idx)]);
  result = result.replace(/\x00IC(\d+)\x00/g, (_match, idx) => inlineCode[parseInt(idx)]);

  return result;
}
