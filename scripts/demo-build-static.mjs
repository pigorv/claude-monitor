#!/usr/bin/env node
// Build a single-file, self-contained static demo HTML by:
//   1. Crawling the running dashboard's API for every view the SPA loads
//   2. Inlining the built JS/CSS from dist/frontend/
//   3. Installing a fetch shim that resolves /api/* paths from the captured
//      snapshot (with client-side filter/sort/pagination for /api/sessions so
//      the chips, search, and column sorts still work without a backend).
//
// Usage:
//   node scripts/demo-build-static.mjs [--base http://localhost:4192] [--out docs/demo.html]
//
// Prereqs:
//   npm run demo:seed
//   HOME=/tmp/cm-demo-home node dist/index.js import /tmp/cm-demo-data
//   HOME=/tmp/cm-demo-home node dist/index.js start --port 4192 --no-open

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const args = process.argv.slice(2);
function flag(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
}
const BASE = flag("base", "http://localhost:4192");
const OUT = resolve(repoRoot, flag("out", "docs/demo.html"));

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

async function main() {
  console.log(`Crawling ${BASE} …`);

  const snapshot = {
    health: await getJson("/api/health"),
    stats: await getJson("/api/stats"),
    projects: await getJson("/api/projects"),
    sessionsAll: await getJson("/api/sessions?limit=500&offset=0&sort=started_at&order=desc"),
    sessions: {},        // id → /api/sessions/:id payload
    events: {},          // id → full events list (with thinking)
    eventsByAgent: {},   // `${id}:${agentId}` → events
  };

  for (const s of snapshot.sessionsAll.sessions) {
    snapshot.sessions[s.id] = await getJson(`/api/sessions/${encodeURIComponent(s.id)}`);
    snapshot.events[s.id] = await getJson(
      `/api/sessions/${encodeURIComponent(s.id)}/events?include_thinking=true&limit=1000&offset=0`
    );
    // Per-agent events for sessions that have agents
    const detail = snapshot.sessions[s.id];
    const agents = detail.agents ?? detail.agent_relationships ?? [];
    for (const a of agents) {
      const aid = a.child_agent_id ?? a.agent_id ?? a.id;
      if (!aid) continue;
      const key = `${s.id}:${aid}`;
      snapshot.eventsByAgent[key] = await getJson(
        `/api/sessions/${encodeURIComponent(s.id)}/events?agent_id=${encodeURIComponent(aid)}&limit=500`
      );
    }
  }

  console.log(
    `  sessions=${snapshot.sessionsAll.sessions.length}` +
    `  events=${Object.values(snapshot.events).reduce((n, e) => n + e.events.length, 0)}` +
    `  per-agent buckets=${Object.keys(snapshot.eventsByAgent).length}`,
  );

  // ── Inline frontend assets ───────────────────────────────────────────
  const distDir = resolve(repoRoot, "dist/frontend");
  const indexHtml = readFileSync(join(distDir, "index.html"), "utf8");
  const assetsDir = join(distDir, "assets");
  const assetFiles = readdirSync(assetsDir);
  const jsFile = assetFiles.find((f) => f.endsWith(".js"));
  const cssFile = assetFiles.find((f) => f.endsWith(".css"));
  if (!jsFile || !cssFile) throw new Error("could not find built JS/CSS in dist/frontend/assets");
  const jsSrc = readFileSync(join(assetsDir, jsFile), "utf8");
  const cssSrc = readFileSync(join(assetsDir, cssFile), "utf8");

  // ── Build the fetch shim ─────────────────────────────────────────────
  // The snapshot is embedded as JSON. The shim:
  //   - resolves GET /api/* requests against snapshot
  //   - applies filter/sort/pagination to /api/sessions so the UI is still
  //     interactive
  //   - returns helpful errors for write endpoints
  //   - never touches non-/api requests (lets the SPA do its own routing).
  const snapshotJson = JSON.stringify(snapshot);

  const shim = `
<script id="cm-demo-data" type="application/json">${
  // Escape </script> so a string in the data can't break out of the inline tag.
  snapshotJson.replace(/</g, "\\u003c")
}</script>
<script>
(function() {
  const dataEl = document.getElementById("cm-demo-data");
  const SNAPSHOT = JSON.parse(dataEl.textContent);
  const origFetch = window.fetch.bind(window);

  function jsonResponse(body, status) {
    return new Response(JSON.stringify(body), {
      status: status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  function notFound() {
    return jsonResponse({ error: "Not found in demo snapshot" }, 404);
  }

  function parseQuery(qs) {
    const params = new URLSearchParams(qs ?? "");
    const out = {};
    for (const [k, v] of params.entries()) out[k] = v;
    return out;
  }

  function modelMatches(rowModel, modelsUsed, chip) {
    if (!chip) return true;
    const all = (modelsUsed && modelsUsed.length ? modelsUsed : [rowModel]).map((m) => (m || "").toLowerCase());
    return all.some((m) => m.includes(chip.toLowerCase()));
  }

  function compareSessions(a, b, sort, order) {
    const dir = order === "asc" ? 1 : -1;
    let av = a[sort];
    let bv = b[sort];
    if (sort === "started_at") {
      av = Date.parse(av || 0);
      bv = Date.parse(bv || 0);
    } else if (typeof av === "string" || typeof bv === "string") {
      av = (av ?? "").toString().toLowerCase();
      bv = (bv ?? "").toString().toLowerCase();
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    }
    return ((av ?? 0) - (bv ?? 0)) * dir;
  }

  function handleSessionsList(query) {
    const q = (query.q || "").toLowerCase().trim();
    const sort = query.sort || "started_at";
    const order = query.order || "desc";
    const limit = Math.max(1, Math.min(500, parseInt(query.limit, 10) || 25));
    const offset = Math.max(0, parseInt(query.offset, 10) || 0);
    const projectPath = query.project_path || "";
    const model = query.model || "";

    let rows = SNAPSHOT.sessionsAll.sessions.slice();
    if (q) {
      rows = rows.filter((s) =>
        (s.summary || "").toLowerCase().includes(q) ||
        (s.project_name || "").toLowerCase().includes(q) ||
        (s.id || "").toLowerCase().includes(q),
      );
    }
    if (projectPath) rows = rows.filter((s) => s.project_path === projectPath);
    if (model) rows = rows.filter((s) => modelMatches(s.model, s.models_used, model));
    rows.sort((a, b) => compareSessions(a, b, sort, order));

    const total = rows.length;
    const page = rows.slice(offset, offset + limit);
    return jsonResponse({ sessions: page, total, limit, offset });
  }

  function handleSessionEvents(id, query) {
    const bucket = SNAPSHOT.events[id];
    if (!bucket) return notFound();
    let rows = bucket.events.slice();
    if (query.agent_id) {
      const byAgent = SNAPSHOT.eventsByAgent[id + ":" + query.agent_id];
      rows = byAgent ? byAgent.events.slice() : rows.filter((e) => e.agent_id === query.agent_id);
    }
    if (query.event_type) rows = rows.filter((e) => e.event_type === query.event_type);
    if (query.tool_name) rows = rows.filter((e) => e.tool_name === query.tool_name);
    if (query.parent_only === "true") rows = rows.filter((e) => !e.agent_id);
    if (query.include_thinking !== "true") rows = rows.filter((e) => e.event_type !== "thinking");
    const limit = Math.max(1, Math.min(2000, parseInt(query.limit, 10) || 100));
    const offset = Math.max(0, parseInt(query.offset, 10) || 0);
    const total = rows.length;
    const page = rows.slice(offset, offset + limit);
    return jsonResponse({ events: page, total, limit, offset });
  }

  function route(method, urlObj) {
    const path = urlObj.pathname;
    const query = parseQuery(urlObj.search.slice(1));

    if (method === "GET") {
      if (path === "/api/health") return jsonResponse(SNAPSHOT.health);
      if (path === "/api/stats") return jsonResponse(SNAPSHOT.stats);
      if (path === "/api/projects") return jsonResponse(SNAPSHOT.projects);
      if (path === "/api/sessions") return handleSessionsList(query);

      let m = path.match(/^\\/api\\/sessions\\/([^/]+)\\/events$/);
      if (m) return handleSessionEvents(decodeURIComponent(m[1]), query);

      m = path.match(/^\\/api\\/sessions\\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const detail = SNAPSHOT.sessions[id];
        return detail ? jsonResponse(detail) : notFound();
      }
    }

    if (method === "POST") {
      // Write endpoints aren't useful in a static demo — return a friendly stub.
      if (path === "/api/reimport") return jsonResponse({ ok: false, message: "Disabled in static demo." }, 503);
      if (path === "/api/clear") return jsonResponse({ ok: false, message: "Disabled in static demo." }, 503);
      if (path.endsWith("/open-terminal")) return jsonResponse({ message: "Terminal opening is disabled in the static demo." }, 503);
    }

    return jsonResponse({ error: "Endpoint not captured in demo snapshot", path, method }, 404);
  }

  window.fetch = function(input, init) {
    try {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const method = (init && init.method) || (input && input.method) || "GET";
      if (!url.startsWith("/api/")) {
        // Pass through for fonts/assets — though there shouldn't be any.
        return origFetch(input, init);
      }
      const u = new URL(url, location.origin);
      return Promise.resolve(route(method.toUpperCase(), u));
    } catch (err) {
      return Promise.resolve(jsonResponse({ error: String(err) }, 500));
    }
  };
})();
</script>
`;

  // ── Compose the final HTML ───────────────────────────────────────────
  // Strip the linked module script + linked stylesheet from the built index,
  // then add a small banner and the inlined assets + fetch shim.
  let out = indexHtml
    .replace(/<script type="module"[^>]*><\/script>\s*/g, "")
    .replace(/<link rel="stylesheet"[^>]*>\s*/g, "")
    // Also strip the icon/manifest links (404 noise when opened via file://).
    .replace(/<link rel="icon"[^>]*>\s*/g, "")
    .replace(/<link rel="apple-touch-icon"[^>]*>\s*/g, "")
    .replace(/<link rel="mask-icon"[^>]*>\s*/g, "")
    .replace(/<link rel="manifest"[^>]*>\s*/g, "")
    .replace(/<title>[^<]*<\/title>/, "<title>claude-monitor — interactive demo</title>");

  const inlined =
    `<style>${cssSrc}</style>\n` +
    shim +
    `<script type="module">${jsSrc}</script>\n`;

  // Use a function replacer so `$&` / `$'` / `$1` substrings inside the
  // minified bundle don't get interpreted as back-references.
  out = out.replace("</head>", () => inlined + "</head>");

  // Insert a tiny "demo" banner (non-intrusive)
  const banner = `
<style>
  #cm-demo-banner {
    position: fixed; bottom: 14px; right: 14px; z-index: 9999;
    font: 500 11px "IBM Plex Mono", ui-monospace, monospace;
    color: #c4b5fd; background: rgba(20, 14, 46, 0.85);
    border: 1px solid rgba(167, 139, 250, 0.35); border-radius: 999px;
    padding: 6px 12px; backdrop-filter: blur(6px); letter-spacing: 0.04em;
    text-transform: uppercase; pointer-events: none;
  }
</style>
`;
  out = out
    .replace(
      "<div id=\"app\"></div>",
      () => "<div id=\"app\"></div>\n<div id=\"cm-demo-banner\">demo · static snapshot</div>",
    )
    .replace("</head>", () => banner + "</head>");

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, out);
  const sizeMb = (Buffer.byteLength(out) / (1024 * 1024)).toFixed(2);
  console.log(`Wrote ${OUT} (${sizeMb} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
