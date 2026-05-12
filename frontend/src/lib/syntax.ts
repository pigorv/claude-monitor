// Lightweight wrapper around Prism for the Write/Edit timeline cards.
// Imports a curated set of grammars side-effectfully (Vite tree-shakes the
// rest of Prism away), maps the human-readable label returned by
// `detectLanguage()` in EventCard.tsx onto a Prism grammar key, and returns
// already-highlighted HTML. Unknown languages fall through to HTML-escaped
// raw text so the caller never has to special-case.

import Prism from "prismjs";

// Markup is the base for html/xml/markdown; load it before anything that
// extends it. clike is the base for c-family / java / etc.
import "prismjs/components/prism-markup";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-python";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-go";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-java";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-css";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-bash";

const LABEL_TO_GRAMMAR: Record<string, string> = {
  TypeScript: "typescript",
  JavaScript: "javascript",
  Python: "python",
  Ruby: "ruby",
  Go: "go",
  Rust: "rust",
  Java: "java",
  JSON: "json",
  YAML: "yaml",
  TOML: "toml",
  Markdown: "markdown",
  HTML: "markup",
  CSS: "css",
  SQL: "sql",
  Shell: "bash",
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Returns HTML with .token.* spans applied. When the language is unknown or
// Prism has no grammar for it, returns HTML-escaped raw text — the caller
// can drop the result into innerHTML either way.
export function highlight(code: string, langLabel: string | null | undefined): string {
  if (!code) return "";
  if (!langLabel) return escapeHtml(code);
  const key = LABEL_TO_GRAMMAR[langLabel];
  if (!key) return escapeHtml(code);
  const grammar = Prism.languages[key];
  if (!grammar) return escapeHtml(code);
  return Prism.highlight(code, grammar, key);
}
