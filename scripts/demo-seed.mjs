#!/usr/bin/env node
// Throwaway seeder for README screenshot capture.
// Emits ~8 synthetic JSONL transcripts under /tmp/cm-demo-data/
// covering: 4 projects, single + multi-model sessions, a session with
// sub-agents, and varied context utilization (low / amber / rose) plus
// compactions for the Health strip.
//
// NOTE: not part of the shipped package. Run with:
//   npm run demo:seed   (or: node scripts/demo-seed.mjs)
// Then:
//   HOME=/tmp/cm-demo-home node dist/index.js import /tmp/cm-demo-data
//   HOME=/tmp/cm-demo-home node dist/index.js start --port 4174 --no-open
//
// Or use npm run demo:walkthrough to drive seed → import → record end-to-end.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const ROOT = "/tmp/cm-demo-data";

// Reset on each run
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

// Models in the same shape Claude Code emits
const M_SONNET = "claude-sonnet-4-5";
const M_SONNET_1M = "claude-sonnet-4-7-1m";
const M_OPUS = "claude-opus-4-7";
const M_HAIKU = "claude-haiku-4-5-20251001";

// Anchor the synthetic time range to "yesterday" so the dashboard
// sorts everything together at the top.
const baseDay = new Date();
baseDay.setUTCHours(9, 0, 0, 0);
baseDay.setUTCDate(baseDay.getUTCDate() - 1);

let lineSeq = 0;
function ts(offsetMs) {
  return new Date(baseDay.getTime() + offsetMs).toISOString();
}

function uuid() {
  return randomUUID();
}

// ── Single-message helpers ─────────────────────────────────────────

function userMsg({ sessionId, cwd, parent, text, time, toolResult }) {
  const u = uuid();
  const content = toolResult
    ? [{ type: "tool_result", tool_use_id: toolResult.id, content: toolResult.content, ...(toolResult.agentId ? { agentId: toolResult.agentId } : {}) }]
    : text;
  const line = {
    parentUuid: parent ?? null,
    cwd,
    sessionId,
    version: "2.1.0",
    type: "user",
    message: { role: "user", content },
    timestamp: time,
    uuid: u,
  };
  // Pass agentId at top level via toolUseResult for Agent/Task results — that's
  // where the importer expects to find the real subagent ID.
  if (toolResult?.agentId) {
    line.toolUseResult = { agentId: toolResult.agentId, agentType: toolResult.agentType ?? "general" };
  }
  return { u, line };
}

function assistantMsg({ sessionId, cwd, parent, time, model, blocks, usage, messageId }) {
  const u = uuid();
  const line = {
    parentUuid: parent ?? null,
    cwd,
    sessionId,
    version: "2.1.0",
    type: "assistant",
    message: {
      id: messageId ?? `msg_${++lineSeq}`,
      model,
      role: "assistant",
      content: blocks,
      ...(usage ? { usage } : {}),
    },
    timestamp: time,
    uuid: u,
  };
  return { u, line };
}

function customTitleLine({ sessionId, title, time }) {
  return {
    type: "custom-title",
    sessionId,
    customTitle: title,
    timestamp: time,
    uuid: uuid(),
  };
}

// Convert a cwd path into the dirname Claude Code actually uses on disk
// (`/Users/x/y` → `-Users-x-y/`). Required so subagent file discovery works.
function projectDirFor(cwd) {
  return cwd.replace(/^\//, "").replace(/\//g, "-");
}

// ── Session builder ────────────────────────────────────────────────

function buildSession({
  sessionId,
  title,
  cwd,
  startMs,
  steps, // [{ kind: "tool"|"text"|"compact"|"agent", ... }]
  primaryModel = M_SONNET,
  largeModel = null,        // optional: switch mid-stream
  switchAfterStep = null,   // step index after which to switch to largeModel
  firstUserText = null,     // if set, used as first-user-msg text in place of `title`
                            // (use this to embed <command-name> tags for command pills)
  trailingSkillExpansions = [], // strings: each becomes a synthetic "Base directory for this skill:"
                                // user message before the closing "Thanks!" so the importer detects
                                // a skill invocation in this session
}) {
  const lines = [];
  // Custom title at the top of the file
  lines.push(customTitleLine({ sessionId, title, time: ts(startMs - 500) }));

  // Initial user message kicks things off
  let { u: lastUuid, line: firstUserLine } = userMsg({
    sessionId, cwd, parent: null,
    text: firstUserText ?? title, // command-tag markup goes here when present
    time: ts(startMs),
  });
  lines.push(firstUserLine);

  // Walk the step recipe
  let cursorMs = startMs + 5_000;
  let runningInput = 8_000; // grows over the conversation
  let runningCacheRead = 0;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const useModel = (largeModel && switchAfterStep !== null && i > switchAfterStep) ? largeModel : primaryModel;

    if (step.kind === "tool") {
      // Assistant emits: thinking + tool_use, with usage
      const toolUseId = `toolu_${sessionId}_${i}`;
      runningInput += step.deltaInput ?? 1_500;
      runningCacheRead += step.deltaCache ?? 4_000;
      const usage = {
        input_tokens: step.inputTokens ?? runningInput,
        output_tokens: step.outputTokens ?? 250,
        cache_read_input_tokens: step.cacheRead ?? runningCacheRead,
        cache_creation_input_tokens: step.cacheWrite ?? 1_200,
      };
      const blocks = [];
      if (step.thinking) {
        blocks.push({ type: "thinking", thinking: step.thinking, signature: "sig-x" });
      }
      blocks.push({
        type: "tool_use",
        id: toolUseId,
        name: step.toolName,
        input: step.toolInput ?? {},
      });
      const { u: aU, line: aLine } = assistantMsg({
        sessionId, cwd, parent: lastUuid, time: ts(cursorMs),
        model: useModel, blocks, usage,
      });
      lines.push(aLine);
      lastUuid = aU;
      cursorMs += 8_000;

      // User responds with tool_result
      const { u: rU, line: rLine } = userMsg({
        sessionId, cwd, parent: lastUuid, time: ts(cursorMs),
        toolResult: { id: toolUseId, content: step.toolOutput ?? "ok" },
      });
      lines.push(rLine);
      lastUuid = rU;
      cursorMs += 2_000;

    } else if (step.kind === "agent") {
      // Assistant calls Task tool with subagent_type
      const toolUseId = `toolu_agent_${sessionId}_${i}`;
      const realAgentId = step.agentId; // we'll write the matching subagent file below
      runningInput += 2_500;
      runningCacheRead += 5_000;
      const usage = {
        input_tokens: runningInput,
        output_tokens: 380,
        cache_read_input_tokens: runningCacheRead,
        cache_creation_input_tokens: 2_000,
      };
      const blocks = [
        { type: "thinking", thinking: step.thinking ?? `Delegating to ${step.subagentType} subagent.`, signature: "sig-x" },
        {
          type: "tool_use",
          id: toolUseId,
          name: "Task",
          input: {
            description: step.description,
            prompt: step.prompt,
            subagent_type: step.subagentType,
          },
        },
      ];
      const { u: aU, line: aLine } = assistantMsg({
        sessionId, cwd, parent: lastUuid, time: ts(cursorMs),
        model: useModel, blocks, usage,
      });
      lines.push(aLine);
      lastUuid = aU;
      cursorMs += 12_000;

      // tool_result with agentId so the importer ties the row to the subagent file
      const { u: rU, line: rLine } = userMsg({
        sessionId, cwd, parent: lastUuid, time: ts(cursorMs),
        toolResult: { id: toolUseId, content: step.result ?? "Done.", agentId: realAgentId, agentType: step.subagentType },
      });
      lines.push(rLine);
      lastUuid = rU;
      cursorMs += 2_000;

      // Stash for the caller — we'll write the subagent file after the parent.
      step._toolUseId = toolUseId;
      step._cursorAtCall = cursorMs;

    } else if (step.kind === "compact") {
      // Compaction: an assistant message whose effective context drops > 30%
      // Big drop: from runningInput to ~30% of it.
      runningInput = Math.round(runningInput * 0.25);
      runningCacheRead = Math.round(runningCacheRead * 0.25);
      const usage = {
        input_tokens: runningInput,
        output_tokens: 80,
        cache_read_input_tokens: runningCacheRead,
        cache_creation_input_tokens: 200,
      };
      const blocks = [
        { type: "text", text: "[Context compacted — continuing.]" },
      ];
      const { u: aU, line: aLine } = assistantMsg({
        sessionId, cwd, parent: lastUuid, time: ts(cursorMs),
        model: useModel, blocks, usage,
      });
      lines.push(aLine);
      lastUuid = aU;
      cursorMs += 4_000;

    } else if (step.kind === "text") {
      // Plain assistant text reply with usage
      runningInput += step.deltaInput ?? 1_000;
      runningCacheRead += step.deltaCache ?? 2_500;
      const usage = {
        input_tokens: step.inputTokens ?? runningInput,
        output_tokens: step.outputTokens ?? 320,
        cache_read_input_tokens: step.cacheRead ?? runningCacheRead,
        cache_creation_input_tokens: step.cacheWrite ?? 800,
      };
      const blocks = [];
      if (step.thinking) blocks.push({ type: "thinking", thinking: step.thinking, signature: "sig-x" });
      blocks.push({ type: "text", text: step.text });
      const { u: aU, line: aLine } = assistantMsg({
        sessionId, cwd, parent: lastUuid, time: ts(cursorMs),
        model: useModel, blocks, usage,
      });
      lines.push(aLine);
      lastUuid = aU;
      cursorMs += 6_000;
    }
  }

  // Synthetic skill-expansion user messages, if any. The importer detects
  // skill invocations by scanning user messages for the literal "Base directory
  // for this skill:" line and extracting the skill name from the path.
  for (const skillPath of trailingSkillExpansions) {
    const { u: sU, line: sLine } = userMsg({
      sessionId, cwd, parent: lastUuid, time: ts(cursorMs + 500),
      text: `<system-reminder>\nBase directory for this skill: ${skillPath}\n</system-reminder>`,
    });
    lines.push(sLine);
    lastUuid = sU;
    cursorMs += 1_000;
  }

  // Final follow-up user message so the chart has at least one closing point
  const { line: finalUserLine } = userMsg({
    sessionId, cwd, parent: lastUuid, time: ts(cursorMs + 1_000),
    text: "Thanks!",
  });
  lines.push(finalUserLine);

  return { sessionId, cwd, lines, steps, durationMs: cursorMs - startMs };
}

// ── Subagent file builder ──────────────────────────────────────────

function buildSubagentTranscript({ parentSessionId, agentId, cwd, startMs, steps, model = M_SONNET }) {
  // Subagent transcript: a minimal user → assistant → tool → assistant chain.
  // Importer keys off agent_id in the file path (basename), not its sessionId.
  const lines = [];
  let lastUuid = null;
  let cursorMs = startMs;
  let runningInput = 6_000;
  let runningCache = 1_200;

  // Initial prompt from parent
  const { u: u0, line: l0 } = userMsg({
    sessionId: agentId, cwd, parent: null,
    text: steps[0]?.prompt ?? "Investigate.",
    time: ts(cursorMs),
  });
  lines.push(l0);
  lastUuid = u0;
  cursorMs += 1_500;

  for (const step of steps) {
    const toolUseId = `toolu_sub_${agentId}_${cursorMs}`;
    runningInput += 1_200;
    runningCache += 2_000;
    const usage = {
      input_tokens: runningInput,
      output_tokens: 180,
      cache_read_input_tokens: runningCache,
      cache_creation_input_tokens: 800,
    };
    const { u: au, line: al } = assistantMsg({
      sessionId: agentId, cwd, parent: lastUuid, time: ts(cursorMs),
      model,
      blocks: [
        { type: "thinking", thinking: step.thinking ?? "Working.", signature: "sig-x" },
        { type: "tool_use", id: toolUseId, name: step.tool, input: step.input ?? {} },
      ],
      usage,
    });
    lines.push(al);
    lastUuid = au;
    cursorMs += 3_000;

    const { u: ru, line: rl } = userMsg({
      sessionId: agentId, cwd, parent: lastUuid, time: ts(cursorMs),
      toolResult: { id: toolUseId, content: step.output ?? "ok" },
    });
    lines.push(rl);
    lastUuid = ru;
    cursorMs += 1_500;
  }

  // Final assistant text reply (the result)
  const final = {
    input_tokens: runningInput + 800,
    output_tokens: 240,
    cache_read_input_tokens: runningCache + 1_500,
    cache_creation_input_tokens: 600,
  };
  const { line: fl } = assistantMsg({
    sessionId: agentId, cwd, parent: lastUuid, time: ts(cursorMs),
    model,
    blocks: [{ type: "text", text: steps[steps.length - 1]?.finalText ?? "Investigation complete." }],
    usage: final,
  });
  lines.push(fl);
  cursorMs += 2_000;

  return { lines, durationMs: cursorMs - startMs };
}

// ── Write helpers ──────────────────────────────────────────────────

function writeSession(sess) {
  const dir = join(ROOT, projectDirFor(sess.cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sess.sessionId}.jsonl`);
  writeFileSync(file, sess.lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

function writeSubagent(parentFile, agentId, transcript) {
  const subDir = join(parentFile.replace(/\.jsonl$/, ""), "subagents");
  mkdirSync(subDir, { recursive: true });
  // Claude Code names subagent files `agent-<id>.jsonl`. The importer derives
  // `child_agent_id` from the basename, and the parent's synthetic id from the
  // tool_use is `agent-<realAgentId>` — both must match for dedup to work.
  const file = join(subDir, `agent-${agentId}.jsonl`);
  writeFileSync(file, transcript.lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

// ── Concrete sessions ──────────────────────────────────────────────

const PROJECTS = {
  api: "/Users/demo/work/api-server",
  ui:  "/Users/demo/work/dashboard-ui",
  recipe: "/Users/demo/personal/recipe-app",
  notes: "/Users/demo/personal/notes-cli",
};

const sessions = [];

// 1. api-server: long Sonnet → Opus session with a compaction (multi-model)
sessions.push(buildSession({
  sessionId: "sess-api-001",
  title: "Refactor request validation middleware",
  cwd: PROJECTS.api,
  startMs: 0,
  primaryModel: M_SONNET,
  largeModel: M_OPUS,
  switchAfterStep: 4,
  firstUserText:
    "<command-name>/refactor</command-name>\n" +
    "<command-message>refactor</command-message>\n" +
    "<command-args>request validation middleware</command-args>",
  trailingSkillExpansions: ["/Users/demo/.claude/skills/code-review/"],
  steps: [
    { kind: "tool", toolName: "Glob", toolInput: { pattern: "src/middleware/**/*.ts" }, toolOutput: "src/middleware/auth.ts\nsrc/middleware/validate.ts\nsrc/middleware/error.ts", thinking: "Need to find all middleware files.", deltaInput: 8_000, deltaCache: 12_000 },
    { kind: "tool", toolName: "Read", toolInput: { file_path: "src/middleware/validate.ts" }, toolOutput: "// 320 lines of validation logic...", deltaInput: 14_000, deltaCache: 22_000 },
    { kind: "tool", toolName: "Grep", toolInput: { pattern: "z.object", glob: "**/*.ts" }, toolOutput: "Found 47 matches across 12 files", deltaInput: 9_000, deltaCache: 18_000 },
    { kind: "tool", toolName: "Read", toolInput: { file_path: "src/routes/users.ts" }, toolOutput: "// 480 lines of route handlers...", deltaInput: 18_000, deltaCache: 26_000 },
    { kind: "compact" }, // compaction marker #1
    { kind: "tool", toolName: "Edit", toolInput: { file_path: "src/middleware/validate.ts" }, toolOutput: "Edit applied", deltaInput: 22_000, deltaCache: 14_000 },
    { kind: "tool", toolName: "Bash", toolInput: { command: "npm test -- middleware" }, toolOutput: "✓ 28 tests passing", deltaInput: 28_000, deltaCache: 18_000 },
    { kind: "text", text: "I refactored the validation middleware to share a base schema and added 6 new tests covering edge cases around optional fields.", deltaInput: 6_000, deltaCache: 12_000 },
  ],
}));

// 2. api-server: short Sonnet session, low pressure
sessions.push(buildSession({
  sessionId: "sess-api-002",
  title: "Add health check endpoint",
  cwd: PROJECTS.api,
  startMs: 90 * 60_000, // 1.5h later
  primaryModel: M_SONNET,
  steps: [
    { kind: "tool", toolName: "Read", toolInput: { file_path: "src/server.ts" }, toolOutput: "// 60 lines", deltaInput: 4_000, deltaCache: 6_000 },
    { kind: "tool", toolName: "Edit", toolInput: { file_path: "src/server.ts" }, toolOutput: "Edit applied", deltaInput: 5_000, deltaCache: 6_000 },
    { kind: "text", text: "Added GET /health returning { status: 'ok', uptime, version }.", deltaInput: 2_000 },
  ],
}));

// 3. dashboard-ui: HEAVY Opus 1M session with subagents — agents screenshot target
const SESS_AGENTS_ID = "sess-dash-002";
sessions.push(buildSession({
  sessionId: SESS_AGENTS_ID,
  title: "Audit dashboard rendering performance",
  cwd: PROJECTS.ui,
  startMs: 4 * 60 * 60_000,
  primaryModel: M_OPUS,
  largeModel: M_SONNET_1M,
  switchAfterStep: 0,
  firstUserText:
    "<command-name>/audit</command-name>\n" +
    "<command-message>audit</command-message>\n" +
    "<command-args>dashboard rendering performance</command-args>",
  trailingSkillExpansions: [
    "/Users/demo/.claude/skills/frontend-design/",
    "/Users/demo/.claude/skills/code-review/",
  ],
  steps: [
    { kind: "tool", toolName: "Glob", toolInput: { pattern: "frontend/src/**/*.tsx" }, toolOutput: "Found 24 files", deltaInput: 12_000, deltaCache: 18_000 },
    { kind: "agent", agentId: "audit-rendering-loop",       subagentType: "general-purpose", description: "Audit rendering hotspots", prompt: "Find components that re-render on every state update and propose useMemo/useCallback fixes. Check for inline object/array literals in JSX, unstable refs, and prop drilling that triggers extra renders.", thinking: "Delegating the rendering audit so the parent context stays small.", result: "Found 3 hot components: Timeline (re-renders on every event update), AgentTree (rebuilds entire layout on hover), SessionList (full re-render on filter change). Detailed findings + fixes in result.", },
    { kind: "agent", agentId: "audit-uplot-config",         subagentType: "general-purpose", description: "Inspect uPlot chart configs",  prompt: "Look for uPlot chart options that cause full redraws on small data updates. Check series resampling, the cursor.lock setting, and whether axis re-computation is being triggered every render.", result: "Two charts pass new opts on each render — switching to memoized opts cuts redraws by ~60%." },
    { kind: "agent", agentId: "audit-bundle-size",          subagentType: "general-purpose", description: "Analyze bundle size",          prompt: "Run the Vite production build with sourcemap analysis. Identify the top 10 contributors to total JS size and flag any duplicates from differing import paths.", result: "uPlot duplicated due to mixed CJS/ESM imports (148kb saving). lodash entirely removed by switching to per-function imports (94kb)." },
    { kind: "agent", agentId: "audit-network-waterfall",    subagentType: "general-purpose", description: "Network waterfall review",     prompt: "Walk through the page-load network waterfall and identify any sequential requests that could be parallelized or any blocking resources.", result: "Two API calls block first paint — moving them to deferred fetch saves ~340ms p75." },
    { kind: "agent", agentId: "audit-render-blocking-css",  subagentType: "general-purpose", description: "Find render-blocking CSS",     prompt: "Identify render-blocking CSS and large unused style rules that could be deferred or removed.", result: "globals.css ships ~22KB of unused tokens. Splitting per-route saves ~14KB on first paint." },
    { kind: "tool", toolName: "Edit", toolInput: { file_path: "frontend/src/pages/SessionList.tsx" }, toolOutput: "Edit applied", deltaInput: 18_000, deltaCache: 20_000 },
    { kind: "tool", toolName: "Bash", toolInput: { command: "npm run build && npm run preview" }, toolOutput: "build ok; preview at localhost:4173", deltaInput: 8_000, deltaCache: 12_000 },
    { kind: "text", text: "5 sub-agents in parallel surfaced 14 distinct fixes; applied the top 4 for an estimated p75 paint improvement of ~520ms.", deltaInput: 6_000, deltaCache: 10_000 },
  ],
}));

// 4. dashboard-ui: short Haiku session
sessions.push(buildSession({
  sessionId: "sess-dash-001",
  title: "Tweak chart axis labels",
  cwd: PROJECTS.ui,
  startMs: 3 * 60 * 60_000,
  primaryModel: M_HAIKU,
  steps: [
    { kind: "tool", toolName: "Edit", toolInput: { file_path: "frontend/src/components/TokenChart.tsx" }, toolOutput: "Edit applied", deltaInput: 3_000, deltaCache: 5_000 },
    { kind: "text", text: "Y-axis now shows compact tokens (k/M) and the cursor tooltip rounds to integers.", deltaInput: 1_500 },
  ],
}));

// 5. recipe-app: mid-pressure Sonnet session with one compaction
sessions.push(buildSession({
  sessionId: "sess-recipe-001",
  title: "Wire up recipe import from URL",
  cwd: PROJECTS.recipe,
  startMs: 6 * 60 * 60_000,
  primaryModel: M_SONNET,
  trailingSkillExpansions: ["/Users/demo/.claude/skills/playwright-cli/"],
  steps: [
    { kind: "tool", toolName: "WebFetch", toolInput: { url: "https://example.com/recipe/123" }, toolOutput: "<html>... 12kb fetched ...</html>", deltaInput: 24_000, deltaCache: 14_000 },
    { kind: "tool", toolName: "Read", toolInput: { file_path: "src/lib/parser.ts" }, toolOutput: "// existing JSON-LD parser, 220 lines", deltaInput: 18_000, deltaCache: 16_000 },
    { kind: "tool", toolName: "Edit", toolInput: { file_path: "src/lib/parser.ts" }, toolOutput: "Edit applied", deltaInput: 22_000, deltaCache: 18_000 },
    { kind: "compact" },
    { kind: "tool", toolName: "Bash", toolInput: { command: "npm test parser" }, toolOutput: "✓ 14 tests", deltaInput: 14_000, deltaCache: 12_000 },
    { kind: "text", text: "Recipe URL importer now handles JSON-LD, microdata, and a manual fallback for sites with neither.", deltaInput: 6_000, deltaCache: 9_000 },
  ],
}));

// 6. notes-cli: tiny Haiku session
sessions.push(buildSession({
  sessionId: "sess-notes-001",
  title: "Fix tag autocomplete in CLI prompt",
  cwd: PROJECTS.notes,
  startMs: 7 * 60 * 60_000,
  primaryModel: M_HAIKU,
  steps: [
    { kind: "tool", toolName: "Read", toolInput: { file_path: "src/cli/prompt.ts" }, toolOutput: "// 80 lines", deltaInput: 2_000, deltaCache: 3_000 },
    { kind: "tool", toolName: "Edit", toolInput: { file_path: "src/cli/prompt.ts" }, toolOutput: "Edit applied", deltaInput: 1_500, deltaCache: 4_000 },
    { kind: "text", text: "Tag completion now triggers on `#` and respects the existing fuzzy-match config.", deltaInput: 1_000 },
  ],
}));

// 7. notes-cli: long Sonnet session with two compactions (rose Health strip)
sessions.push(buildSession({
  sessionId: "sess-notes-002",
  title: "Migrate notes storage from JSON to SQLite",
  cwd: PROJECTS.notes,
  startMs: 7.5 * 60 * 60_000,
  primaryModel: M_SONNET,
  firstUserText:
    "<command-name>/migrate</command-name>\n" +
    "<command-message>migrate</command-message>\n" +
    "<command-args>notes storage from JSON to SQLite</command-args>",
  trailingSkillExpansions: ["/Users/demo/.claude/skills/release-readme/"],
  steps: [
    { kind: "tool", toolName: "Read", toolInput: { file_path: "src/storage/json-store.ts" }, toolOutput: "// 410 lines", deltaInput: 18_000, deltaCache: 18_000 },
    { kind: "tool", toolName: "Glob", toolInput: { pattern: "src/storage/**" }, toolOutput: "12 files", deltaInput: 8_000, deltaCache: 14_000 },
    { kind: "tool", toolName: "Read", toolInput: { file_path: "src/storage/migrate.ts" }, toolOutput: "// 280 lines", deltaInput: 16_000, deltaCache: 22_000 },
    { kind: "compact" },
    { kind: "tool", toolName: "Edit", toolInput: { file_path: "src/storage/sqlite-store.ts" }, toolOutput: "Edit applied (new file)", deltaInput: 28_000, deltaCache: 16_000 },
    { kind: "tool", toolName: "Bash", toolInput: { command: "npm test storage" }, toolOutput: "✓ 32 tests", deltaInput: 18_000, deltaCache: 14_000 },
    { kind: "compact" },
    { kind: "tool", toolName: "Edit", toolInput: { file_path: "src/storage/index.ts" }, toolOutput: "Edit applied", deltaInput: 22_000, deltaCache: 14_000 },
    { kind: "tool", toolName: "Bash", toolInput: { command: "npm test" }, toolOutput: "✓ 188 tests", deltaInput: 32_000, deltaCache: 22_000 },
    { kind: "text", text: "Migration cuts cold-load time on a 5k-note vault from 1.4s to 65ms; old JSON store kept as a fallback behind --legacy.", deltaInput: 4_000, deltaCache: 8_000 },
  ],
}));

// 8. recipe-app: short single-model run (Opus)
sessions.push(buildSession({
  sessionId: "sess-recipe-002",
  title: "Fix dark-mode contrast on recipe cards",
  cwd: PROJECTS.recipe,
  startMs: 8 * 60 * 60_000,
  primaryModel: M_OPUS,
  steps: [
    { kind: "tool", toolName: "Read", toolInput: { file_path: "src/components/RecipeCard.css" }, toolOutput: "// 90 lines", deltaInput: 2_500, deltaCache: 5_000 },
    { kind: "tool", toolName: "Edit", toolInput: { file_path: "src/components/RecipeCard.css" }, toolOutput: "Edit applied", deltaInput: 2_000, deltaCache: 4_500 },
    { kind: "text", text: "Bumped text/background contrast to 4.6:1 (passes WCAG AA), and reworked the bookmark icon's hover state.", deltaInput: 1_200 },
  ],
}));

// ── Write all sessions ─────────────────────────────────────────────

for (const sess of sessions) {
  const file = writeSession(sess);

  // For sessions with agent steps, write each subagent transcript to disk
  for (const step of sess.steps) {
    if (step.kind === "agent" && step.agentId) {
      const sub = buildSubagentTranscript({
        parentSessionId: sess.sessionId,
        agentId: step.agentId,
        cwd: sess.cwd,
        startMs: 0,
        steps: [
          { prompt: step.prompt, tool: "Glob", input: { pattern: "**/*.tsx" }, output: "Found 24 matches", thinking: "Scanning the codebase." },
          { tool: "Read", input: { file_path: "frontend/src/components/Timeline.tsx" }, output: "// 320 lines", thinking: "Reading the heaviest component." },
          { tool: "Grep", input: { pattern: "useMemo|useCallback", glob: "**/*.tsx" }, output: "12 matches", thinking: "Cross-checking memoization.", finalText: step.result },
        ],
      });
      writeSubagent(file, step.agentId, sub);
    }
  }

  console.log(`  ${sess.sessionId.padEnd(20)} ${sess.lines.length} lines  ${sess.cwd}`);
}

console.log(`\nWrote ${sessions.length} sessions to ${ROOT}`);
console.log("Next:");
console.log("  HOME=/tmp/cm-demo-home node dist/index.js import /tmp/cm-demo-data");
console.log("  HOME=/tmp/cm-demo-home node dist/index.js start --port 4174 --no-open");
