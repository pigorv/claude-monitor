# Security Policy

## About This Project

claude-monitor is a **local-only** observability tool. It reads Claude Code transcript files from your filesystem and serves a dashboard on `localhost`. There is no remote API, authentication, or multi-user access by default.

## Reporting a Vulnerability

If you discover a security issue, please report it through [GitHub Security Advisories](https://github.com/pigorv/claude-monitor/security/advisories/new) rather than opening a public issue. This keeps the details private until a fix is available.

You can expect an initial response within 7 days.

## Scope

Examples of issues we'd consider security-relevant:

- **Path traversal** — transcript import reading or writing files outside the expected directories
- **Malicious JSONL content** — crafted transcript data that causes code execution, XSS in the dashboard, or SQLite injection
- **Dependency vulnerabilities** — known CVEs in direct dependencies that are reachable in claude-monitor's usage

Examples of things that are **not** in scope:

- Attacks requiring physical access to the machine already running claude-monitor
- Denial-of-service against the local server (it only binds to localhost)
- Issues in Claude Code itself (report those to [Anthropic](https://www.anthropic.com))

## Supported Versions

Security fixes are applied to the latest release only.
