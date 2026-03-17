---
name: debug-pipeline
description: >
  End-to-end data pipeline debugger for claude-monitor. Traces data from raw JSONL transcripts
  through SQLite ingestion to API responses to frontend rendering. Use this skill whenever
  the user reports a data issue, missing session, wrong token counts, broken chart, missing events,
  incorrect risk scores, agent tree problems, or any discrepancy between what's in the transcript
  and what's shown in the dashboard. Also trigger when the user says things like "why isn't X showing",
  "the data looks wrong", "session is missing", "tokens don't match", "chart is broken",
  "events aren't appearing", "reimport didn't work", or wants to inspect how a specific
  JSONL file was processed. Covers the full pipeline: JSONL parsing, event extraction,
  token tracking, risk scoring, DB storage, API retrieval, and Playwright-based UI verification.
allowed-tools: Bash(sqlite3:*), Bash(playwright-cli:*), Read(*), Grep(*), Glob(*)
---

# Debug Pipeline

You are debugging the claude-monitor data pipeline. Your job is to trace data from its source
(JSONL transcript files) through each transformation stage to where the user sees a problem,
and identify exactly where data gets lost, transformed incorrectly, or displayed wrong.

## Debugging Philosophy

Comparing data between layers (JSONL vs DB vs API vs UI) is only half the job. The other half —
and often the more important half — is **questioning the transformation logic itself**. When data
looks wrong, the bug might not be in how data moves between layers, but in the formulas and
assumptions the code uses to compute derived values.

For example, if a compaction looks suspicious, don't just verify the token drop happened in the DB.
Go read `token-tracker.ts` and check whether `effectiveContextTokens` is computed correctly from
all the right fields (`input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`).
If a risk score looks wrong, don't just check the inputs — verify the formula weights and
thresholds match what you'd expect.

**Always ask: "Is the code computing this value correctly?" — not just "Does this value match
between layers?"**

## Triage: Start at the Right Layer

Before diving in, figure out which layer is most likely broken based on the user's description.
Don't always trace the full pipeline — start where the problem likely lives and work outward.

| Symptom | Start here | Then check |
|---------|-----------|------------|
| "Session not importing" / "session missing" | JSONL source → Ingestion | DB |
| "Wrong token counts" / "chart looks off" | DB (token data) → **transformation code** | JSONL source |
| "Events missing" / "tool calls not showing" | DB (events table) | JSONL source → extraction code |
| "Risk score seems wrong" | DB (session record) → **risk-scoring.ts formula** | Token snapshots in events |
| "Compaction looks wrong" | **token-tracker.ts formula** → JSONL raw usage | DB |
| "Agent tree broken" / "subagents missing" | DB (agent_relationships) | JSONL subagent files |
| "UI shows X but API returns Y" | API response → UI (Playwright) | — |
| "Dashboard looks wrong" | UI (Playwright) → API | DB |
| "Reimport didn't fix it" | DB (check timestamps) | Force reimport |

## Layer 1: JSONL Source Files

Transcript files live in `~/.claude/projects/`. Each project directory contains session JSONL files.

### Finding the right file

```bash
# Find JSONL files for a project (use project path from DB or user description)
find ~/.claude/projects/ -path "*<project-name>*" -name "*.jsonl" -type f | head -20

# If you have a session ID, check the DB for the transcript_path
sqlite3 "$HOME/.claude-monitor/data.sqlite" "SELECT transcript_path FROM sessions WHERE id = '<session-id>'"
```

### Inspecting JSONL content

Each line is a JSON object. Key fields to check:

```bash
# Count messages by type
cat <file.jsonl> | python3 -c "
import sys, json
counts = {}
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        obj = json.loads(line)
        t = obj.get('type', 'unknown')
        counts[t] = counts.get(t, 0) + 1
    except: pass
print(json.dumps(counts, indent=2))
"

# Check first/last message timestamps
head -1 <file.jsonl> | python3 -m json.tool | grep timestamp
tail -1 <file.jsonl> | python3 -m json.tool | grep timestamp

# Find assistant messages with usage info (these become token snapshots)
cat <file.jsonl> | python3 -c "
import sys, json
for i, line in enumerate(sys.stdin):
    try:
        obj = json.loads(line.strip())
        msg = obj.get('message', {})
        if msg.get('role') == 'assistant' and 'usage' in msg:
            u = msg['usage']
            print(f'Line {i}: input={u.get(\"input_tokens\",0)} output={u.get(\"output_tokens\",0)} cache_read={u.get(\"cache_read_input_tokens\",0)}')
    except: pass
"

# Find tool_use blocks (these become tool_call events)
cat <file.jsonl> | python3 -c "
import sys, json
for i, line in enumerate(sys.stdin):
    try:
        obj = json.loads(line.strip())
        msg = obj.get('message', {})
        content = msg.get('content', [])
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get('type') == 'tool_use':
                    print(f'Line {i}: {block.get(\"name\")} (id: {block.get(\"id\",\"?\")[:12]}...)')
    except: pass
"
```

### Subagent files

Subagent transcripts live in `<session-dir>/subagents/`. The parent JSONL will contain
Agent/Task tool_use blocks whose results reference these subagent IDs.

```bash
# Check for subagent files
find "$(dirname <parent-jsonl>)" -path "*/subagents/*.jsonl" -type f
```

### Inspecting raw usage fields

The Anthropic API returns several token fields that matter for context tracking. When debugging
token-related issues, always extract ALL usage fields — the ingestion code may not use all of them:

```bash
# Extract ALL usage fields from assistant messages (not just input/output)
cat <file.jsonl> | python3 -c "
import sys, json
for i, line in enumerate(sys.stdin):
    try:
        obj = json.loads(line.strip())
        msg = obj.get('message', {})
        if msg.get('role') == 'assistant' and 'usage' in msg:
            u = msg['usage']
            print(f'Line {i}:')
            print(f'  input_tokens={u.get(\"input_tokens\",0)}')
            print(f'  output_tokens={u.get(\"output_tokens\",0)}')
            print(f'  cache_read={u.get(\"cache_read_input_tokens\",0)}')
            print(f'  cache_creation={u.get(\"cache_creation_input_tokens\",0)}')
            total = u.get('input_tokens',0) + u.get('cache_read_input_tokens',0) + u.get('cache_creation_input_tokens',0)
            print(f'  effective_context={total}')
    except: pass
"
```

This is critical because the effective context should include input_tokens + cache_read + cache_creation.
If the code only uses a subset, you'll get false compaction detections or wrong context_pct values.
After extracting raw values, compare them against what `token-tracker.ts` computes — read the
`buildTokenSnapshots()` function to verify its formula matches the full set of fields.

### Common JSONL issues
- **Empty or truncated file**: Session was killed mid-write
- **Missing usage field**: Some messages don't have token counts (skipped by token-tracker)
- **String content instead of array**: Parser normalizes this, but check if it's malformed
- **Duplicate sessionIds**: Multiple files can share a sessionId if session was split
- **Cache rotation**: When the API's ephemeral cache expires between turns, tokens shift from
  `cache_read_input_tokens` to `cache_creation_input_tokens`. The total context stays the same,
  but if the code only tracks a subset of these fields, it will see a phantom drop

## Layer 2: Database Verification

The SQLite database lives at `~/.claude-monitor/data.sqlite`. Use sqlite3 CLI directly.

### Session-level checks

```bash
# Get full session record
sqlite3 "$HOME/.claude-monitor/data.sqlite" \
  "SELECT id, project_name, model, status, started_at, ended_at, duration_ms, \
   total_input_tokens, total_output_tokens, peak_context_pct, compaction_count, \
   tool_call_count, subagent_count, risk_score, transcript_path \
   FROM sessions WHERE id = '<session-id>'"

# Search sessions by project
sqlite3 "$HOME/.claude-monitor/data.sqlite" \
  "SELECT id, project_name, started_at, risk_score FROM sessions \
   WHERE project_path LIKE '%<project>%' ORDER BY started_at DESC LIMIT 10"

# Check if session was imported (vs missing)
sqlite3 "$HOME/.claude-monitor/data.sqlite" \
  "SELECT COUNT(*) FROM sessions WHERE id = '<session-id>'"
```

### Event-level checks

```bash
# Event type distribution for a session
sqlite3 "$HOME/.claude-monitor/data.sqlite" \
  "SELECT event_type, COUNT(*) as cnt FROM events \
   WHERE session_id = '<session-id>' GROUP BY event_type ORDER BY cnt DESC"

# Token timeline (what the chart renders from)
sqlite3 "$HOME/.claude-monitor/data.sqlite" \
  "SELECT sequence_num, event_type, input_tokens, output_tokens, \
   cache_read_tokens, context_pct \
   FROM events WHERE session_id = '<session-id>' AND input_tokens IS NOT NULL \
   ORDER BY sequence_num ASC"

# Tool calls for a session
sqlite3 "$HOME/.claude-monitor/data.sqlite" \
  "SELECT sequence_num, tool_name, duration_ms, \
   substr(input_preview, 1, 80) as preview \
   FROM events WHERE session_id = '<session-id>' AND tool_name IS NOT NULL \
   ORDER BY sequence_num ASC"

# Check for agent-scoped events
sqlite3 "$HOME/.claude-monitor/data.sqlite" \
  "SELECT agent_id, COUNT(*) FROM events \
   WHERE session_id = '<session-id>' AND agent_id IS NOT NULL \
   GROUP BY agent_id"
```

### Agent relationship checks

```bash
# Agent relationships for a session
sqlite3 "$HOME/.claude-monitor/data.sqlite" \
  "SELECT child_agent_id, status, duration_ms, input_tokens_total, \
   output_tokens_total, tool_call_count, compression_ratio, execution_mode \
   FROM agent_relationships WHERE parent_session_id = '<session-id>'"

# Session links (plan → implementation)
sqlite3 "$HOME/.claude-monitor/data.sqlite" \
  "SELECT * FROM session_links WHERE source_session_id = '<session-id>' \
   OR target_session_id = '<session-id>'"
```

### Cross-layer validation

Compare JSONL source data against what's in the DB. This catches ingestion bugs.

```bash
# Count: JSONL assistant messages with usage vs DB events with input_tokens
# JSONL side:
cat <file.jsonl> | python3 -c "
import sys, json
count = 0
for line in sys.stdin:
    try:
        obj = json.loads(line.strip())
        if obj.get('message',{}).get('role') == 'assistant' and 'usage' in obj.get('message',{}):
            count += 1
    except: pass
print(f'JSONL assistant messages with usage: {count}')
"

# DB side:
sqlite3 "$HOME/.claude-monitor/data.sqlite" \
  "SELECT COUNT(*) as db_count FROM events \
   WHERE session_id = '<session-id>' AND input_tokens IS NOT NULL"
```

### Common DB issues
- **Stale data after code change**: Reimport needed (`POST /api/reimport` or CLI `--force`)
- **NULL context_pct**: Message had no usage info, or token-tracker skipped it
- **Zero compaction_count but high peak_context_pct**: Compaction threshold might not have been crossed
- **Missing agent_relationships**: Subagent JSONL file wasn't found or wasn't in expected path
- **Duplicate events after reimport**: Delete + reinsert should prevent this, but check sequence_nums

## Layer 3: API Verification

The Hono server runs on port 4173 (production) or the Vite proxy on 5173 (dev).

```bash
# Check if server is running
curl -s http://localhost:4173/api/health | python3 -m json.tool

# Get session detail (same payload the frontend uses)
curl -s "http://localhost:4173/api/sessions/<session-id>" | python3 -m json.tool

# Get events for a session
curl -s "http://localhost:4173/api/sessions/<session-id>/events?limit=200" | python3 -m json.tool

# Get session list
curl -s "http://localhost:4173/api/sessions?limit=10" | python3 -m json.tool

# Compare: API token timeline vs raw DB
curl -s "http://localhost:4173/api/sessions/<session-id>" | python3 -c "
import sys, json
data = json.load(sys.stdin)
timeline = data.get('token_timeline', [])
print(f'API timeline points: {len(timeline)}')
if timeline:
    print(f'First: context_pct={timeline[0].get(\"context_pct\")}')
    print(f'Last:  context_pct={timeline[-1].get(\"context_pct\")}')
    compactions = [t for t in timeline if t.get('is_compaction')]
    print(f'Compaction events: {len(compactions)}')
"
```

### API vs DB discrepancies
- The API joins and transforms data (e.g., `getSession` + `getTokenTimeline` + `getAgentRelationships`)
- Token timeline filters to `input_tokens IS NOT NULL` — rows without tokens are invisible
- Session list uses a projection (SESSION_LIST_COLUMNS) that excludes metadata
- Events endpoint defaults to limit=100 — check if events are paginated away

## Layer 4: UI Verification (Playwright)

Use playwright-cli to check what the user actually sees in the browser.

```bash
# Open the dashboard
playwright-cli open
playwright-cli goto http://localhost:5173

# Navigate to a specific session
playwright-cli goto "http://localhost:5173/#/sessions/<session-id>"

# Take a snapshot of what's rendered
playwright-cli snapshot

# Screenshot for visual verification
playwright-cli screenshot

# Check specific elements (use refs from snapshot)
playwright-cli click <ref>  # e.g., click a tab

# Verify the Context tab (token chart)
# Navigate to session detail, click Context tab, then snapshot
playwright-cli snapshot
```

### What to look for in the UI
- **Session list**: Is the session showing? Is the risk badge correct? Sparkline present?
- **Timeline tab**: Are events rendering? Correct count? Tool calls grouped?
- **Context tab**: Does the chart have data points? Compaction markers showing?
- **Agents tab**: Agent tree populated? Efficiency metrics correct?

### Common UI issues
- **Stale frontend build**: Run `npm run build` to rebuild, or use Vite dev server
- **API proxy misconfigured**: Vite dev server proxies `/api` to port 4173 — backend must be running
- **Chart renders empty**: Token timeline has 0 or 1 data points (need >= 2 for uPlot)
- **Missing sparklines**: Mini timeline returns empty array for sessions without context_pct events

## Layer 5: Transformation Code Audit

This is the layer most people skip, but it's where the deepest bugs hide. When data "looks wrong"
at any layer, don't stop at comparing values between layers — **read the code that computes
derived values and verify its logic against the raw inputs**.

### Key transformation files and what to audit

| File | Computes | Common pitfalls |
|------|----------|-----------------|
| `src/ingestion/token-tracker.ts` | `context_pct`, compaction detection, token snapshots | Missing fields in effective context calc (e.g., `cache_creation_input_tokens`); wrong model threshold lookup |
| `src/ingestion/thinking-extractor.ts` | Event types, tool call merging, agent ID assignment | Orphaned tool_call_end events; agent ID extraction regex failures; content block type mismatches |
| `src/ingestion/transcript-importer.ts` | Session aggregates, event records, `context_pct` per event | `buildEventRecords()` may compute `context_pct` differently from `token-tracker.ts`; `computeAggregates()` may use wrong token field for totals |
| `src/analysis/risk-scoring.ts` | `risk_score` (0.0–1.0 composite) | Discrete quantization from integer inputs (subagent counts, compaction counts); weight/threshold mismatches |
| `src/db/queries/events.ts` | Token timeline query, `is_compaction` flag | Uses `CASE WHEN event_type = 'compaction'` but events may not have that type set; `WHERE input_tokens IS NOT NULL` filters out events silently |

### Audit checklist

When a derived value looks wrong:

1. **Find the raw JSONL fields** that feed into the computation
2. **Read the function** that transforms them — don't assume it's correct
3. **Manually compute** the expected result from raw inputs using the function's formula
4. **Compare** your manual result with what's in the DB
5. **If they match**: the formula is implemented correctly but may be *conceptually* wrong (e.g., missing a field)
6. **If they don't match**: there's a code bug in the transformation

### Example: Verifying context_pct computation

```bash
# 1. Get raw JSONL usage for a specific message
cat <file.jsonl> | python3 -c "
import sys, json
for i, line in enumerate(sys.stdin):
    try:
        obj = json.loads(line.strip())
        msg = obj.get('message', {})
        if msg.get('role') == 'assistant' and 'usage' in msg:
            u = msg['usage']
            # Compute what context_pct SHOULD be (all context fields / model max)
            effective = u.get('input_tokens',0) + u.get('cache_read_input_tokens',0) + u.get('cache_creation_input_tokens',0)
            pct = (effective / 200000) * 100  # assuming 200K model
            print(f'Line {i}: effective={effective} expected_pct={pct:.2f}%')
    except: pass
"

# 2. Compare with what's in the DB
sqlite3 "$HOME/.claude-monitor/data.sqlite" \
  "SELECT sequence_num, input_tokens, cache_read_tokens, context_pct \
   FROM events WHERE session_id = '<session-id>' AND input_tokens IS NOT NULL \
   ORDER BY sequence_num ASC"

# 3. Read the code to see what formula it actually uses
# grep for 'effectiveContext' or 'context_pct' in token-tracker.ts
```

## Debugging Workflow Summary

1. **Identify the symptom** and pick the starting layer from the triage table
2. **Verify the data at that layer** using the queries/commands above
3. **Compare with the adjacent layer** to find where data diverges
4. **Audit the transformation code** — don't just compare data, read the functions that compute
   derived values and verify they use the right inputs and formulas. This is where the deepest
   bugs live. Key files:
   - JSONL → events: `src/ingestion/thinking-extractor.ts`
   - Messages → tokens: `src/ingestion/token-tracker.ts`
   - Events → risk: `src/analysis/risk-scoring.ts`
   - DB → API: `src/server/routes/` + `src/db/queries/`
   - API → UI: `frontend/src/pages/SessionDetail.tsx` + component files
5. **Manually recompute** at least one derived value from raw inputs to confirm the code's formula
6. **Report findings**: State what the data looks like at each layer, where it diverges, and
   whether the bug is in data flow or in the computation logic itself

Always show the actual data values at each layer you check — don't just say "it looks wrong",
show the concrete numbers/values so the user can see the discrepancy.
