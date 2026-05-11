import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import render from 'preact-render-to-string';
import { html } from 'htm/preact';
import { renderMarkdown, renderJson, renderStructuredInner, detectFormat } from '../../frontend/src/lib/markdown.js';
import { StructuredContent } from '../../frontend/src/components/StructuredContent.js';

// ─── detectFormat ──────────────────────────────────────────

describe('detectFormat', () => {
  it('detects JSON objects', () => {
    assert.equal(detectFormat('{"a": 1}'), 'json');
  });

  it('detects JSON arrays', () => {
    assert.equal(detectFormat('[1, 2, 3]'), 'json');
  });

  it('detects whitespace-prefixed JSON', () => {
    assert.equal(detectFormat('  \n{"a": 1}\n'), 'json');
  });

  it('does not classify malformed JSON as json', () => {
    assert.notEqual(detectFormat('{not really json'), 'json');
  });

  it('detects fenced code blocks as markdown', () => {
    assert.equal(detectFormat('here is some\n```\ncode\n```'), 'markdown');
  });

  it('detects headings as markdown', () => {
    assert.equal(detectFormat('# Title\n\nbody'), 'markdown');
  });

  it('detects bold as markdown', () => {
    assert.equal(detectFormat('this has **bold** in it'), 'markdown');
  });

  it('detects 2+ bullet items as markdown', () => {
    assert.equal(detectFormat('- one\n- two'), 'markdown');
  });

  it('detects 2+ numbered items as markdown', () => {
    assert.equal(detectFormat('1. one\n2. two'), 'markdown');
  });

  it('detects <system-reminder> tags as markdown', () => {
    assert.equal(detectFormat('<system-reminder>be brief</system-reminder>'), 'markdown');
  });

  it('detects <example> tags as markdown', () => {
    assert.equal(detectFormat('<example>sample</example>'), 'markdown');
  });

  it('detects blockquotes as markdown', () => {
    assert.equal(detectFormat('> a quote\n> continues'), 'markdown');
  });

  it('does not promote a single hyphen line to markdown', () => {
    assert.equal(detectFormat('- alone'), 'plain');
  });

  it('falls back to plain for ordinary prose', () => {
    assert.equal(detectFormat('Just a normal sentence without any markup.'), 'plain');
  });

  it('returns plain for empty text', () => {
    assert.equal(detectFormat(''), 'plain');
  });
});

// ─── renderJson ────────────────────────────────────────────

describe('renderJson', () => {
  it('pretty-prints valid JSON', () => {
    const html = renderJson('{"a":1,"b":2}');
    assert.ok(html.includes('json-block'), 'wraps in json-block class');
    // Quotes are HTML-escaped to &quot; in the rendered output
    assert.ok(html.includes('&quot;a&quot;: 1'), 'pretty-prints with indent');
    assert.ok(html.includes('&quot;b&quot;: 2'));
  });

  it('escapes HTML inside JSON values', () => {
    const html = renderJson('{"x":"<script>"}');
    assert.ok(html.includes('&lt;script&gt;'), 'angle brackets are escaped');
    assert.ok(!html.includes('<script>'), 'raw script tag does not survive');
  });

  it('falls back to escaped plain pre for invalid JSON', () => {
    const html = renderJson('{not json');
    assert.ok(html.includes('<pre class="detail-content">'));
    assert.ok(!html.includes('json-block'));
  });
});

// ─── renderMarkdown (regressions + new features) ───────────

describe('renderMarkdown — existing behaviour unchanged', () => {
  it('renders bold inside a paragraph', () => {
    const out = renderMarkdown('hello **world**');
    assert.ok(out.includes('<strong>world</strong>'));
    assert.ok(out.includes('<p>'));
  });

  it('renders unordered lists', () => {
    const out = renderMarkdown('- a\n- b');
    assert.ok(out.includes('<ul>'));
    assert.ok(out.includes('<li>a</li>'));
    assert.ok(out.includes('<li>b</li>'));
  });

  it('renders fenced code blocks', () => {
    const out = renderMarkdown('```\nlet x = 1;\n```');
    assert.ok(out.includes('md-code-block'));
    assert.ok(out.includes('let x = 1;'));
  });

  it('renders inline code', () => {
    const out = renderMarkdown('use `npm test` to verify');
    assert.ok(out.includes('md-inline-code'));
    assert.ok(out.includes('npm test'));
  });

  it('renders headings', () => {
    assert.ok(renderMarkdown('# Title').includes('<h3>Title</h3>'));
    assert.ok(renderMarkdown('## Title').includes('<h4>Title</h4>'));
    assert.ok(renderMarkdown('### Title').includes('<h5>Title</h5>'));
  });

  it('returns empty string for empty input', () => {
    assert.equal(renderMarkdown(''), '');
  });

  it('escapes raw HTML in plain text', () => {
    const out = renderMarkdown('avoid <script>alert(1)</script> here');
    assert.ok(out.includes('&lt;script&gt;'));
    assert.ok(!out.includes('<script>alert'));
  });
});

describe('renderMarkdown — blockquotes', () => {
  it('renders a single-line blockquote', () => {
    const out = renderMarkdown('> a quote');
    assert.ok(out.includes('<blockquote class="md-blockquote">'));
    assert.ok(out.includes('a quote'));
  });

  it('joins consecutive blockquote lines into one block', () => {
    const out = renderMarkdown('> hello\n> world');
    const matches = out.match(/<blockquote/g) ?? [];
    assert.equal(matches.length, 1, 'one blockquote element');
    assert.ok(out.includes('hello'));
    assert.ok(out.includes('world'));
  });
});

describe('renderMarkdown — preserved tags', () => {
  it('renders <system-reminder> as a styled block with visible label', () => {
    const out = renderMarkdown('<system-reminder>be brief</system-reminder>');
    assert.ok(out.includes('md-tagged-block'));
    assert.ok(out.includes('md-tag-system-reminder'));
    assert.ok(out.includes('&lt;system-reminder&gt;'), 'opening tag shown as label');
    assert.ok(out.includes('&lt;/system-reminder&gt;'), 'closing tag shown as label');
    assert.ok(out.includes('be brief'));
  });

  it('renders <example> as a styled block', () => {
    const out = renderMarkdown('<example>sample text</example>');
    assert.ok(out.includes('md-tag-example'));
    assert.ok(out.includes('sample text'));
  });

  it('processes markdown inside a preserved tag', () => {
    const out = renderMarkdown('<system-reminder>this is **bold**</system-reminder>');
    assert.ok(out.includes('<strong>bold</strong>'), 'bold renders inside the tag');
  });

  it('does not leave a stray wrapping <p> around the tagged block', () => {
    const out = renderMarkdown('<system-reminder>solo</system-reminder>');
    assert.ok(!out.match(/<p><div class="md-tagged-block/), 'no wrapping paragraph');
  });

  it('handles nested tags', () => {
    const out = renderMarkdown('<example><system-reminder>inner</system-reminder></example>');
    assert.ok(out.includes('md-tag-example'));
    assert.ok(out.includes('md-tag-system-reminder'));
    assert.ok(out.includes('inner'));
  });
});

describe('renderMarkdown — assistant_message regression', () => {
  // A snapshot-style assertion: typical assistant content (paragraphs, bold,
  // bullet list, inline code) renders to the SAME string it always has.
  it('renders an assistant-style message identically to the pre-change baseline', () => {
    const input = [
      'Here is the **summary**:',
      '',
      '- first point',
      '- second point with `code`',
      '',
      'Done.',
    ].join('\n');
    const out = renderMarkdown(input);
    const expected =
      '<p>Here is the <strong>summary</strong>:</p>' +
      '<ul><li>first point</li><li>second point with <code class="md-inline-code">code</code></li></ul>' +
      '<p>Done.</p>';
    assert.equal(out, expected);
  });
});

// ─── renderStructuredInner (sibling helper for existing containers) ─

describe('renderStructuredInner', () => {
  it('returns escaped pretty JSON without a wrapper when hint="json"', () => {
    const out = renderStructuredInner('{"a":1,"b":2}', 'json');
    assert.ok(!out.startsWith('<'), 'no wrapping element');
    assert.ok(out.includes('&quot;a&quot;: 1'), 'pretty-prints + escapes');
    assert.ok(out.includes('\n'), 'preserves newline for indent');
  });

  it('wraps markdown output in <div class="md-rendered"> when hint="markdown"', () => {
    const out = renderStructuredInner('**bold**', 'markdown');
    assert.ok(out.startsWith('<div class="md-rendered">'));
    assert.ok(out.includes('<strong>bold</strong>'));
    assert.ok(out.endsWith('</div>'));
  });

  it('returns escaped text without a wrapper for plain content', () => {
    const out = renderStructuredInner('just <text> here');
    assert.equal(out, 'just &lt;text&gt; here');
  });

  it('falls back to escaped plain when JSON hint with malformed input', () => {
    const out = renderStructuredInner('not json', 'json');
    assert.equal(out, 'not json');
  });

  it('auto-detects markdown when no hint is supplied', () => {
    const out = renderStructuredInner('# Heading\n\nbody');
    assert.ok(out.includes('md-rendered'));
    assert.ok(out.includes('<h3>Heading</h3>'));
  });

  it('auto-detects JSON when no hint is supplied', () => {
    const out = renderStructuredInner('[1, 2, 3]');
    assert.ok(!out.includes('md-rendered'), 'no markdown wrapper');
    assert.ok(out.includes('[\n  1,\n  2,\n  3\n]'));
  });

  it('returns empty string for empty text', () => {
    assert.equal(renderStructuredInner(''), '');
  });
});

// ─── StructuredContent component ───────────────────────────

describe('StructuredContent', () => {
  it('renders a json-block when hint="json" and text is valid JSON', () => {
    const out = render(html`<${StructuredContent} text=${'{"a":1}'} hint="json" />`);
    assert.ok(out.includes('json-block'));
    // HTM/Preact escapes quotes in text content
    assert.ok(out.includes('&quot;a&quot;: 1'));
  });

  it('falls back to plain pre when hint="json" but text is invalid', () => {
    const out = render(html`<${StructuredContent} text=${'not json'} hint="json" />`);
    assert.ok(out.includes('<pre class="detail-content">'));
    assert.ok(!out.includes('json-block'));
  });

  it('renders markdown-content wrapper when hint="markdown"', () => {
    const out = render(html`<${StructuredContent} text=${'**bold**'} hint="markdown" />`);
    assert.ok(out.includes('markdown-content'));
    assert.ok(out.includes('<strong>bold</strong>'));
  });

  it('falls through to plain pre for non-detected formats', () => {
    const out = render(html`<${StructuredContent} text=${'plain text only'} />`);
    assert.ok(out.includes('<pre class="detail-content">'));
    assert.ok(!out.includes('markdown-content'));
    assert.ok(!out.includes('json-block'));
  });

  it('auto-detects JSON when no hint is given', () => {
    const out = render(html`<${StructuredContent} text=${'{"x": 1}'} />`);
    assert.ok(out.includes('json-block'));
  });

  it('auto-detects markdown when no hint is given', () => {
    const out = render(html`<${StructuredContent} text=${'# Heading'} />`);
    assert.ok(out.includes('markdown-content'));
    assert.ok(out.includes('<h3>Heading</h3>'));
  });

  it('returns null for empty text', () => {
    const out = render(html`<${StructuredContent} text=${''} />`);
    assert.equal(out, '');
  });
});
