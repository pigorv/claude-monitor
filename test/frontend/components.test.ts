import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import render from 'preact-render-to-string';
import { html } from 'htm/preact';
import { Heatmap } from '../../frontend/src/components/Heatmap.js';
import { EventCard } from '../../frontend/src/components/EventCard.js';
import { CompactionBanner } from '../../frontend/src/components/CompactionBanner.js';
import { AgentTree } from '../../frontend/src/components/AgentTree.js';
import { groupTimelineItems } from '../../frontend/src/components/Timeline.js';
import { Dropdown } from '../../frontend/src/components/Dropdown.js';
import { FilterBar } from '../../frontend/src/components/FilterBar.js';
import { TokenBudgetSummary } from '../../frontend/src/components/TokenBudgetSummary.js';
import { ExportButton } from '../../frontend/src/components/ExportButton.js';
import { transformTimeline } from '../../frontend/src/lib/chart-config.js';
import type { Event as SessionEvent, AgentRelationship, TokenDataPoint, ProjectInfo, EventAnnotation, TokenBudget } from '../../src/shared/types.js';

// ─── Heatmap ────────────────────────────────────────────

describe('Heatmap', () => {
  function makePoint(context_pct: number): TokenDataPoint {
    return {
      timestamp: '2026-01-15T10:00:00Z',
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 10,
      context_pct,
      event_type: 'assistant_message',
      is_compaction: false,
    };
  }

  it('returns empty for empty timeline', () => {
    const out = render(html`<${Heatmap} timeline=${[]} />`);
    assert.equal(out, '', 'empty timeline should render nothing');
  });

  it('renders cells for valid timeline', () => {
    const timeline = [makePoint(10), makePoint(50), makePoint(80)];
    const out = render(html`<${Heatmap} timeline=${timeline} />`);
    assert.ok(out.includes('heatmap-strip'), 'should render strip container');
    assert.ok(out.includes('heatmap-cell'), 'should render cells');
    assert.ok(out.includes('heatmap-labels'), 'should render labels');
    assert.ok(out.includes('Session start'), 'should have start label');
    assert.ok(out.includes('Session end'), 'should have end label');
  });

  it('renders correct number of cells for small data', () => {
    const timeline = Array.from({ length: 5 }, (_, i) => makePoint(i * 20));
    const out = render(html`<${Heatmap} timeline=${timeline} />`);
    const cellCount = (out.match(/heatmap-cell/g) || []).length;
    assert.equal(cellCount, 5, 'should have one cell per data point when < 50');
  });

  it('downsamples to max 50 cells for large data', () => {
    const timeline = Array.from({ length: 200 }, (_, i) => makePoint((i / 200) * 100));
    const out = render(html`<${Heatmap} timeline=${timeline} />`);
    const cellCount = (out.match(/heatmap-cell/g) || []).length;
    assert.equal(cellCount, 50, 'should downsample to 50 cells');
  });

  it('applies color based on context percentage', () => {
    const timeline = [makePoint(90)];
    const out = render(html`<${Heatmap} timeline=${timeline} />`);
    assert.ok(out.includes('var(--health-rose)'), 'high context should use the rose health token');
  });
});

// ─── EventCard ──────────────────────────────────────────

describe('EventCard', () => {
  function makeEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
    return {
      id: 1,
      session_id: 'sess-1',
      event_type: 'assistant_message',
      tool_name: null,
      timestamp: '2026-01-15T10:05:00Z',
      context_pct: 45,
      duration_ms: null,
      input_preview: null,
      output_preview: 'Hello world',
      thinking_summary: null,
      thinking_text: null,
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 10,
      cache_write_tokens: 5,
      agent_id: null,
      input_data: null,
      output_data: null,
      ...overrides,
    } as SessionEvent;
  }

  it('renders assistant message with event card class', () => {
    const out = render(html`<${EventCard} event=${makeEvent()} />`);
    assert.ok(out.includes('event-card'), 'should have event-card class');
    assert.ok(out.includes('event-assistant-message'), 'should have assistant message type class');
  });

  it('renders user message type', () => {
    const evt = makeEvent({ event_type: 'user_message', input_preview: 'Fix bug' });
    const out = render(html`<${EventCard} event=${evt} />`);
    assert.ok(out.includes('event-user-message'), 'should have user message type class');
    assert.ok(out.includes('Fix bug'), 'should show user message text');
  });

  it('renders tool call with tool badge', () => {
    const evt = makeEvent({
      event_type: 'tool_call_start',
      tool_name: 'Read',
      input_preview: '/src/index.ts',
    });
    const out = render(html`<${EventCard} event=${evt} />`);
    assert.ok(out.includes('tool-badge'), 'should render tool badge');
    assert.ok(out.includes('tool-read'), 'Read tool should have read class');
    assert.ok(out.includes('Read'), 'should show tool name');
  });

  it('renders compaction banner', () => {
    const evt = makeEvent({
      event_type: 'compaction',
      input_tokens: 500000,
      output_tokens: 200000,
      context_pct: 18,
    });
    const out = render(html`<${EventCard} event=${evt} />`);
    assert.ok(out.includes('compaction-banner'), 'should render compaction banner');
    assert.ok(out.includes('Auto-compaction triggered'), 'should show title');
    assert.ok(!out.includes('500.0K'), 'should not show before tokens');
    assert.ok(!out.includes('200.0K'), 'should not show after tokens');
    // The row's own context_pct is the POST-drop value — it must not be
    // presented as the pressure that triggered compaction.
    assert.ok(!out.includes('18%'), 'should not show post-drop context percentage');
    assert.ok(out.includes('Context window compacted'), 'should show neutral description without metadata');
  });

  it('renders pre-drop pressure from compaction metadata', () => {
    const evt = makeEvent({
      event_type: 'compaction',
      context_pct: 18,
      metadata: JSON.stringify({ compaction: { tokens_before: 160452, context_pct_before: 80.2 } }),
    });
    const out = render(html`<${EventCard} event=${evt} />`);
    assert.ok(out.includes('Context pressure reached 80% before compaction'), 'should show pre-drop percentage');
    assert.ok(!out.includes('18%'), 'should not show post-drop context percentage');
  });

  it('renders thinking event with summary preview', () => {
    const evt = makeEvent({
      event_type: 'thinking',
      thinking_summary: 'Analyzing the code...',
      thinking_text: 'Full thinking content here',
    });
    const out = render(html`<${EventCard} event=${evt} />`);
    assert.ok(out.includes('event-thinking'), 'thinking should have thinking type class');
    assert.ok(out.includes('Analyzing the code...'), 'should show summary in collapsed state');
  });

  it('renders context mini-bar with correct color', () => {
    const evt = makeEvent({ context_pct: 75 });
    const out = render(html`<${EventCard} event=${evt} />`);
    assert.ok(out.includes('ctx-minibar'), 'should render context minibar');
    assert.ok(out.includes('75%'), 'should show percentage');
    // DS migration: minibar now uses two-tier ctx tokens (>=70% danger, else warning)
    assert.ok(out.includes('var(--color-status-danger-text)'), 'context >= 70% should be danger');
  });

  it('hides context mini-bar for low context', () => {
    const evt = makeEvent({ context_pct: 15 });
    const out = render(html`<${EventCard} event=${evt} />`);
    assert.ok(!out.includes('ctx-minibar'), 'context < 50% should not render minibar');
  });

  it('renders event card when agent ID is present', () => {
    const evt = makeEvent({ agent_id: 'agent-abc123def456' });
    const out = render(html`<${EventCard} event=${evt} />`);
    assert.ok(out.includes('event-card'), 'should still render event card');
  });

  it('renders duration when present', () => {
    const evt = makeEvent({ duration_ms: 2500 });
    const out = render(html`<${EventCard} event=${evt} />`);
    assert.ok(out.includes('2.5s'), 'should format duration');
  });

  it('renders timestamp', () => {
    const evt = makeEvent({ timestamp: '2026-01-15T10:05:30Z' });
    const out = render(html`<${EventCard} event=${evt} sessionStart=${'2026-01-15T10:00:00Z'} />`);
    assert.ok(out.includes('event-time'), 'should show event time');
  });

  it('renders expand indicator for expandable events', () => {
    const evt = makeEvent({ thinking_text: 'some text' });
    const out = render(html`<${EventCard} event=${evt} />`);
    assert.ok(out.includes('event-expand'), 'should show expand indicator');
    assert.ok(out.includes('▸'), 'should show right arrow (collapsed)');
  });

  it('renders all event types without error', () => {
    const types = [
      'session_start', 'session_end', 'tool_call_start', 'tool_call_end',
      'subagent_start', 'subagent_end', 'compaction', 'thinking',
      'assistant_message', 'user_message', 'notification',
    ];
    for (const t of types) {
      const evt = makeEvent({ event_type: t as any });
      const out = render(html`<${EventCard} event=${evt} />`);
      // tool_call_start renders as lightweight tool-row-standalone, not event-card
      const expected = t === 'tool_call_start' ? 'tool-row-standalone' : 'event-card';
      assert.ok(out.includes(expected), `${t} should render ${expected}`);
    }
  });
});

// ─── CompactionBanner (standalone) ──────────────────────

describe('CompactionBanner', () => {
  function makeCompactionEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
    return {
      id: 2,
      session_id: 'sess-1',
      event_type: 'compaction',
      tool_name: null,
      timestamp: '2026-01-15T10:05:00Z',
      context_pct: 18,
      duration_ms: null,
      input_preview: null,
      output_preview: null,
      thinking_summary: null,
      thinking_text: null,
      input_tokens: 500000,
      output_tokens: 200000,
      cache_read_tokens: 10,
      cache_write_tokens: 5,
      agent_id: null,
      input_data: null,
      output_data: null,
      metadata: null,
      ...overrides,
    } as SessionEvent;
  }

  it('renders without token pair or post-drop percentage', () => {
    const out = render(html`<${CompactionBanner} event=${makeCompactionEvent()} />`);
    assert.ok(out.includes('compaction-banner-standalone'), 'should render standalone banner');
    assert.ok(out.includes('Auto-compaction triggered'), 'should show title');
    assert.ok(!out.includes('500.0K'), 'should not show before tokens');
    assert.ok(!out.includes('200.0K'), 'should not show after tokens');
    assert.ok(!out.includes('18%'), 'should not show post-drop context percentage');
    assert.ok(out.includes('Context window compacted'), 'should show neutral description without metadata');
  });

  it('renders pre-drop pressure from metadata', () => {
    const evt = makeCompactionEvent({
      metadata: JSON.stringify({ compaction: { tokens_before: 160452, context_pct_before: 80.2 } }),
    });
    const out = render(html`<${CompactionBanner} event=${evt} />`);
    assert.ok(out.includes('Context pressure reached 80% before compaction'), 'should show pre-drop percentage');
  });

  it('falls back to the neutral line on corrupt metadata', () => {
    const evt = makeCompactionEvent({ metadata: '{not valid json' });
    const out = render(html`<${CompactionBanner} event=${evt} />`);
    assert.ok(out.includes('Context window compacted'), 'should show neutral description');
  });
});

// ─── EventCard: Write/Edit full-card render ─────────────

describe('EventCard Write/Edit cards', () => {
  function makeWrite(content: string, overrides: Partial<SessionEvent> = {}): SessionEvent {
    return {
      id: 1, session_id: 'sess-1',
      event_type: 'tool_call_start', tool_name: 'Write',
      timestamp: '2026-01-15T10:05:00Z',
      context_pct: 30, duration_ms: 1200,
      input_preview: null, output_preview: null,
      thinking_summary: null, thinking_text: null,
      input_tokens: null, output_tokens: 5400, cache_read_tokens: 12000, cache_write_tokens: null,
      agent_id: null,
      input_data: JSON.stringify({ file_path: '/Users/me/proj/src/foo.ts', content }),
      output_data: null,
      ...overrides,
    } as SessionEvent;
  }

  function makeEdit(oldStr: string, newStr: string, overrides: Partial<SessionEvent> = {}): SessionEvent {
    return {
      id: 2, session_id: 'sess-1',
      event_type: 'tool_call_start', tool_name: 'Edit',
      timestamp: '2026-01-15T10:05:00Z',
      context_pct: 30, duration_ms: 800,
      input_preview: null, output_preview: null,
      thinking_summary: null, thinking_text: null,
      input_tokens: null, output_tokens: 2100, cache_read_tokens: null, cache_write_tokens: null,
      agent_id: null,
      input_data: JSON.stringify({ file_path: '/Users/me/proj/src/foo.py', old_string: oldStr, new_string: newStr }),
      output_data: null,
      ...overrides,
    } as SessionEvent;
  }

  it('renders Write as full mutating card with diff-view body and write tint class', () => {
    const out = render(html`<${EventCard} event=${makeWrite('const x = 1;\nconst y = 2;\n')} />`);
    assert.ok(out.includes('event-card-mutating'), 'should use mutating card layout');
    assert.ok(out.includes('event-card-write'), 'Write tool should get write-tint class');
    assert.ok(!out.includes('event-card-edit'), 'Write must not also get edit class');
    assert.ok(out.includes('diff-view'), 'should render diff-view body');
    assert.ok(out.includes('event-card-meta-pill'), 'should render header meta pill');
  });

  it('renders Edit as mutating card with diff-line-add and diff-line-remove rows', () => {
    const out = render(html`<${EventCard} event=${makeEdit('print("old")\n', 'print("new")\n')} />`);
    assert.ok(out.includes('event-card-edit'), 'Edit tool should get edit-tint class');
    assert.ok(!out.includes('event-card-write'), 'Edit must not also get write class');
    assert.ok(out.includes('diff-line-add'), 'changed range should produce an add line');
    assert.ok(out.includes('diff-line-remove'), 'changed range should produce a remove line');
  });

  it('puts language label (derived from extension) into the meta pill', () => {
    const tsOut = render(html`<${EventCard} event=${makeWrite('x', { input_data: JSON.stringify({ file_path: '/a/b.ts', content: 'x' }) })} />`);
    assert.ok(tsOut.includes('TypeScript'), '.ts → TypeScript label');
    const pyOut = render(html`<${EventCard} event=${makeWrite('x', { input_data: JSON.stringify({ file_path: '/a/b.py', content: 'x' }) })} />`);
    assert.ok(pyOut.includes('Python'), '.py → Python label');
  });

  it('escapes <script> in Write content (Prism path does not allow raw HTML injection)', () => {
    const xss = '<script>alert("xss")</script>';
    const out = render(html`<${EventCard} event=${makeWrite(xss + '\nconst x = 1;\n')} />`);
    assert.ok(!out.includes('<script>alert'), 'literal <script>alert must never appear');
    assert.ok(!out.includes('</script>'), 'literal closing </script> must never appear either');
    assert.ok(out.includes('&lt;'), 'opening angle brackets must be HTML-entity escaped');
  });

  it('escapes raw HTML in Edit diff body too', () => {
    const out = render(html`<${EventCard} event=${makeEdit('safe\n', '<img src=x onerror=alert(1)>\n')} />`);
    assert.ok(!out.includes('<img src=x onerror'), 'raw HTML must not pass through to output');
    assert.ok(out.includes('&lt;'), 'opening angle bracket should be escaped to &lt;');
  });

  it('shows the rationale row when a rationale prop is passed', () => {
    const out = render(html`<${EventCard} event=${makeWrite('x')} rationale=${'Refactor the parser to handle empty input.'} />`);
    assert.ok(out.includes('event-card-rationale-row'), 'should render rationale row');
    assert.ok(out.includes('Refactor the parser'), 'should include rationale text');
  });

  it('truncates a rationale longer than 240 chars and shows the in-line expand chip', () => {
    const long = 'A'.repeat(300);
    const out = render(html`<${EventCard} event=${makeWrite('x')} rationale=${long} />`);
    assert.ok(!out.includes('A'.repeat(300)), 'long rationale should be truncated');
    assert.ok(out.includes('A'.repeat(240) + '…'), 'should slice to RAT_MAX and append the ellipsis');
    assert.ok(out.includes('event-card-rationale-row'), 'rationale row should render');
    assert.ok(out.includes('event-card-more-lines'), 'in-line expand chip should render in the rationale row');
  });

  it('omits the rationale row when no rationale and context is low', () => {
    const out = render(html`<${EventCard} event=${makeWrite('x', { context_pct: 20 })} />`);
    assert.ok(!out.includes('event-card-rationale-row'), 'no rationale + low ctx → no rationale row');
  });

  it('renders expand chip when content exceeds the 10-line preview cap', () => {
    const longContent = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const out = render(html`<${EventCard} event=${makeWrite(longContent)} />`);
    assert.ok(out.includes('expand-btn'), 'should show expand button');
    assert.ok(out.includes('Show 10 more lines'), 'should report 10 hidden lines');
    // The body uses the unified .expand-btn; the rationale row uses .event-card-more-lines.
    // No rationale prop is passed here, so the rationale chip should not render.
    assert.ok(!out.includes('event-card-more-lines'), 'no rationale chip when no rationale prop');
  });

  it('does not render expand chip when content fits the preview', () => {
    const out = render(html`<${EventCard} event=${makeWrite('a\nb\nc\n')} />`);
    assert.ok(!out.includes('expand-btn'), 'no body expand button when nothing is hidden');
    assert.ok(!out.includes('event-card-more-lines'), 'no rationale chip either');
  });

  it('always renders the Copy button on Write cards, even when content is empty', () => {
    const out = render(html`<${EventCard} event=${makeWrite('')} />`);
    assert.ok(out.includes('copy-btn'), 'empty Write should still expose Copy button');
  });

  it('applies mutating-error class when the tool result is an error', () => {
    const evt = makeWrite('x', {
      metadata: JSON.stringify({ tool_error: true }),
    } as Partial<SessionEvent>);
    const out = render(html`<${EventCard} event=${evt} />`);
    assert.ok(out.includes('event-card-mutating-error'), 'errored Write should carry the error class');
    assert.ok(out.includes('err-badge'), 'and should show an error badge in the header');
  });

  it('shows rejected badge when permission is denied', () => {
    const evt = makeWrite('x', {
      metadata: JSON.stringify({ permission_status: 'rejected' }),
    } as Partial<SessionEvent>);
    const out = render(html`<${EventCard} event=${evt} />`);
    assert.ok(out.includes('permission-badge rejected'), 'rejected permission should show rejected badge');
  });

  it('renders the shortened file path in the header', () => {
    const out = render(html`<${EventCard} event=${makeWrite('x', { input_data: JSON.stringify({ file_path: '/Users/me/proj/src/foo.ts', content: 'x' }) })} />`);
    assert.ok(out.includes('event-card-mutating-path'), 'should render path slot');
    assert.ok(out.includes('foo.ts'), 'shortened path should at least include the file name');
  });
});

// ─── EventCard: AskUserQuestion card ────────────────────

// SSR-only coverage of the collapsed L1 row. The L2 expanded body (per-question
// answers, multi-select tag, custom-value tag, options grid, raw-output
// fallback, `annotations.notes`) lives behind useState(expanded === true) and
// needs jsdom + fireEvent to drive the toggle — not in this repo today. Same
// limitation as copy-button.test.ts; revisit when jsdom lands.

describe('EventCard AskUserQuestion card', () => {
  function makeAsk(
    questions: unknown[],
    overrides: Partial<SessionEvent> = {},
  ): SessionEvent {
    return {
      id: 1, session_id: 'sess-1',
      event_type: 'tool_call_start', tool_name: 'AskUserQuestion',
      timestamp: '2026-01-15T10:05:00Z',
      context_pct: 30, duration_ms: 1200,
      input_preview: null, output_preview: null,
      thinking_summary: null, thinking_text: null,
      input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null,
      agent_id: null,
      input_data: JSON.stringify({ questions }),
      output_data: null,
      ...overrides,
    } as SessionEvent;
  }

  it('renders the ask-card row with AskUserQuestion badge and tool-edit class', () => {
    const out = render(html`<${EventCard} event=${makeAsk([{ question: 'Library?' }])} />`);
    assert.ok(out.includes('ask-card'), 'should apply ask-card class to the row');
    assert.ok(out.includes('tool-edit'), 'should apply the tool-edit badge class (toolTagClass maps AskUserQuestion → tool-edit via ask keyword)');
    assert.ok(out.includes('AskUserQuestion'), 'badge text should be AskUserQuestion');
  });

  it('shows the first question text in the collapsed row', () => {
    const evt = makeAsk([{ question: 'Which library should we use?' }]);
    const out = render(html`<${EventCard} event=${evt} />`);
    assert.ok(out.includes('Which library should we use?'), 'first question text should appear in L1');
  });

  it('shows the "N questions" chip when there is more than one question', () => {
    const evt = makeAsk([
      { question: 'Q1?' }, { question: 'Q2?' }, { question: 'Q3?' },
    ]);
    const out = render(html`<${EventCard} event=${evt} />`);
    assert.ok(out.includes('ask-questions-count'), 'multi-question chip should render');
    assert.ok(out.includes('3 questions'), 'chip should report the question count');
  });

  it('omits the "N questions" chip for a single question', () => {
    const out = render(html`<${EventCard} event=${makeAsk([{ question: 'Just one?' }])} />`);
    assert.ok(!out.includes('ask-questions-count'), 'no chip when there is only one question');
  });

  it('surfaces the is-rejected meta tag when metadata.permission_status === "rejected"', () => {
    const evt = makeAsk([{ question: 'Q?' }], {
      metadata: JSON.stringify({ permission_status: 'rejected' }),
    } as Partial<SessionEvent>);
    const out = render(html`<${EventCard} event=${evt} />`);
    assert.ok(out.includes('ask-meta-tag is-rejected'), 'rejected tag should render');
    assert.ok(!out.includes('ask-meta-tag is-error'), 'error tag should NOT render for plain rejection');
  });

  it('surfaces the is-error meta tag when metadata.tool_error is true', () => {
    const evt = makeAsk([{ question: 'Q?' }], {
      metadata: JSON.stringify({ tool_error: true }),
    } as Partial<SessionEvent>);
    const out = render(html`<${EventCard} event=${evt} />`);
    assert.ok(out.includes('ask-meta-tag is-error'), 'error tag should render');
  });

  it('error tag takes precedence over rejected tag when both flags are set', () => {
    const evt = makeAsk([{ question: 'Q?' }], {
      metadata: JSON.stringify({ tool_error: true, permission_status: 'rejected' }),
    } as Partial<SessionEvent>);
    const out = render(html`<${EventCard} event=${evt} />`);
    assert.ok(out.includes('ask-meta-tag is-error'), 'error tag should render');
    assert.ok(!out.includes('ask-meta-tag is-rejected'), 'rejected tag should be suppressed when tool_error is also set');
  });

  it('falls back to "AskUserQuestion" as the row title when questions array is empty', () => {
    const out = render(html`<${EventCard} event=${makeAsk([])} />`);
    // The badge text and the fallback header text are both "AskUserQuestion",
    // so we expect at least two occurrences in the output.
    const count = (out.match(/AskUserQuestion/g) ?? []).length;
    assert.ok(count >= 2, 'badge + header fallback should both render the literal AskUserQuestion');
  });

  it('truncates a long single-question header to 60 chars + ellipsis', () => {
    const longQ = 'A'.repeat(120) + '?';
    const out = render(html`<${EventCard} event=${makeAsk([{ question: longQ }])} />`);
    assert.ok(!out.includes('A'.repeat(120)), 'long header should be truncated');
    assert.ok(out.includes('A'.repeat(60) + '…'), 'should truncate to 60 chars and append the ellipsis');
  });

  it('renders the right-arrow expand chevron in the collapsed initial render', () => {
    const out = render(html`<${EventCard} event=${makeAsk([{ question: 'Q?' }])} />`);
    assert.ok(out.includes('tool-row-expand'), 'expand chevron container should render');
    assert.ok(out.includes('›'), 'should show right arrow in collapsed state');
  });

  it('renders a duration when duration_ms is set', () => {
    const evt = makeAsk([{ question: 'Q?' }], { duration_ms: 3400 });
    const out = render(html`<${EventCard} event=${evt} />`);
    assert.ok(out.includes('3.4s'), 'should format duration on the ask-card row');
  });
});

// ─── AgentTree / AgentFlow ──────────────────────────────

describe('AgentTree', () => {
  function makeAgent(overrides: Partial<AgentRelationship> = {}): AgentRelationship {
    return {
      id: 1,
      parent_session_id: 'sess-1',
      child_agent_id: 'agent-abc123',
      child_transcript_path: '/tmp/transcript.jsonl',
      prompt_preview: 'Search for the user model',
      result_preview: 'Found UserModel in src/models/',
      prompt_data: null,
      result_data: null,
      started_at: '2026-01-15T10:02:00Z',
      ended_at: '2026-01-15T10:05:00Z',
      duration_ms: 180000,
      input_tokens_total: 50000,
      output_tokens_total: 20000,
      tool_call_count: 8,
      status: 'completed',
      internal_tool_calls: [],
      prompt_tokens: null,
      result_tokens: null,
      peak_context_tokens: null,
      compression_ratio: null,
      agent_compaction_count: 0,
      parent_headroom_at_return: null,
      parent_impact_pct: null,
      result_classification: null,
      execution_mode: null,
      files_read_count: 0,
      files_total_tokens: 0,
      spawn_timestamp: null,
      complete_timestamp: null,
      ...overrides,
    };
  }

  it('renders empty state message', () => {
    const out = render(html`<${AgentTree} agents=${[]} />`);
    assert.ok(out.includes('No sub-agents spawned'), 'should show empty state');
  });

  it('renders agent tree with summary', () => {
    const agents = [makeAgent()];
    const out = render(html`<${AgentTree} agents=${agents} />`);
    assert.ok(out.includes('agent-tree'), 'should render tree container');
    assert.ok(out.includes('sub-agent'), 'should show count (singular)');
    assert.ok(!out.includes('sub-agents'), 'should not be plural for single agent');
    assert.ok(out.includes('completed'), 'should show status count');
  });

  it('renders plural agent count', () => {
    const agents = [makeAgent({ id: 1 }), makeAgent({ id: 2, child_agent_id: 'agent-def456' })];
    const out = render(html`<${AgentTree} agents=${agents} />`);
    assert.ok(out.includes('sub-agents'), 'should show plural count');
  });

  it('renders gantt chart with data', () => {
    const agents = [makeAgent()];
    const out = render(html`<${AgentTree} agents=${agents} sessionStart=${'2026-01-15T10:00:00Z'} />`);
    assert.ok(out.includes('gantt-chart'), 'should render gantt chart');
    assert.ok(out.includes('agent-abc123'), 'should show agent ID');
    assert.ok(out.includes('completed'), 'should show status');
    assert.ok(out.includes('Search for the user model'), 'should show description from prompt preview');
  });

  it('renders summary with token totals', () => {
    const agents = [makeAgent()];
    const out = render(html`<${AgentTree} agents=${agents} />`);
    assert.ok(out.includes('70.0K'), 'should show combined tokens');
    assert.ok(out.includes('tokens'), 'should label tokens');
    assert.ok(out.includes('8'), 'should show tool call count');
  });

  it('renders token info in gantt stats', () => {
    const agents = [makeAgent()];
    const out = render(html`<${AgentTree} agents=${agents} />`);
    assert.ok(out.includes('50.0K'), 'should show input tokens');
    assert.ok(out.includes('20.0K'), 'should show output tokens');
    assert.ok(out.includes('gantt-stat'), 'should have gantt stat elements');
  });

  it('does not render removed components', () => {
    const agents = [makeAgent()];
    const out = render(html`<${AgentTree} agents=${agents} />`);
    assert.ok(!out.includes('agent-flow'), 'should not render old flow diagram');
    assert.ok(!out.includes('agent-card'), 'should not render old agent cards');
    assert.ok(!out.includes('concurrency-timeline'), 'should not render old timeline');
  });

  it('renders multiple agent statuses', () => {
    const agents = [
      makeAgent({ id: 1, status: 'completed' }),
      makeAgent({ id: 2, child_agent_id: 'agent-2', status: 'running' }),
      makeAgent({ id: 3, child_agent_id: 'agent-3', status: 'error' }),
    ];
    const out = render(html`<${AgentTree} agents=${agents} />`);
    assert.ok(out.includes('sub-agents'), 'should show plural count');
    assert.ok(out.includes('completed'), 'should show completed status');
    assert.ok(out.includes('running'), 'should show running status');
    assert.ok(out.includes('error'), 'should show error status');
  });

  it('sorts agents by start time', () => {
    const agents = [
      makeAgent({ id: 2, child_agent_id: 'agent-late', started_at: '2026-01-15T10:10:00Z' }),
      makeAgent({ id: 1, child_agent_id: 'agent-early', started_at: '2026-01-15T10:01:00Z' }),
    ];
    const out = render(html`<${AgentTree} agents=${agents} />`);
    const earlyIdx = out.indexOf('agent-early');
    const lateIdx = out.indexOf('agent-late');
    assert.ok(earlyIdx < lateIdx, 'earlier agent should appear first');
  });
});

// ─── Signal Badges (via EventCard context bar) ──────────

describe('Signal badges (context mini-bars)', () => {
  function makeEvent(context_pct: number): SessionEvent {
    return {
      id: 1,
      session_id: 'sess-1',
      event_type: 'assistant_message',
      tool_name: null,
      timestamp: '2026-01-15T10:05:00Z',
      context_pct,
      duration_ms: null,
      input_preview: null,
      output_preview: null,
      thinking_summary: null,
      thinking_text: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      agent_id: null,
      input_data: null,
      output_data: null,
    } as SessionEvent;
  }

  it('no minibar for context < 50%', () => {
    const out = render(html`<${EventCard} event=${makeEvent(20)} />`);
    assert.ok(!out.includes('ctx-minibar'), 'context < 50% should not render minibar');
  });

  // DS migration: minibar collapsed to two tiers — 50-69% → warning token, >=70% → danger token
  it('warning token for context 50-59%', () => {
    const out = render(html`<${EventCard} event=${makeEvent(55)} />`);
    assert.ok(out.includes('var(--color-status-warning-text)'));
  });

  it('warning token for context 60-70%', () => {
    const out = render(html`<${EventCard} event=${makeEvent(65)} />`);
    assert.ok(out.includes('var(--color-status-warning-text)'));
  });

  it('danger token for context >= 70%', () => {
    const out = render(html`<${EventCard} event=${makeEvent(85)} />`);
    assert.ok(out.includes('var(--color-status-danger-text)'));
  });

  it('caps bar width at 100%', () => {
    const out = render(html`<${EventCard} event=${makeEvent(120)} />`);
    assert.ok(out.includes('width: 100%'), 'should cap at 100% width');
  });
});

// ─── groupTimelineItems (tool grouping) ─────────────────

describe('groupTimelineItems', () => {
  function makeToolEvent(id: number, tool_name: string, overrides: Partial<SessionEvent> = {}): SessionEvent {
    return {
      id,
      session_id: 'sess-1',
      event_type: 'tool_call_start',
      tool_name,
      timestamp: `2026-01-15T10:0${id}:00Z`,
      context_pct: 30,
      duration_ms: 100,
      input_preview: null,
      output_preview: null,
      thinking_summary: null,
      thinking_text: null,
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: null,
      cache_write_tokens: null,
      agent_id: null,
      input_data: null,
      output_data: null,
      metadata: null,
      ...overrides,
    } as SessionEvent;
  }

  function makeEvent(id: number, event_type: string, overrides: Partial<SessionEvent> = {}): SessionEvent {
    return {
      id,
      session_id: 'sess-1',
      event_type: event_type as any,
      tool_name: null,
      timestamp: `2026-01-15T10:0${id}:00Z`,
      context_pct: 30,
      duration_ms: null,
      input_preview: null,
      output_preview: null,
      thinking_summary: null,
      thinking_text: null,
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: null,
      cache_write_tokens: null,
      agent_id: null,
      input_data: null,
      output_data: null,
      metadata: null,
      ...overrides,
    } as SessionEvent;
  }

  it('groups consecutive calls of the same tool', () => {
    const events = [
      makeToolEvent(1, 'Read'),
      makeToolEvent(2, 'Read'),
      makeToolEvent(3, 'Read'),
    ];
    const items = groupTimelineItems(events);
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'tool-group');
    if (items[0].type === 'tool-group') {
      assert.equal(items[0].events.length, 3);
    }
  });

  it('does NOT group different tool types together', () => {
    const events = [
      makeToolEvent(1, 'Read'),
      makeToolEvent(2, 'Glob'),
      makeToolEvent(3, 'Write'),
    ];
    const items = groupTimelineItems(events);
    assert.equal(items.length, 3);
    assert.ok(items.every(i => i.type === 'event'), 'each different tool should be a standalone event');
  });

  it('creates separate groups for different consecutive tool runs', () => {
    const events = [
      makeToolEvent(1, 'Read'),
      makeToolEvent(2, 'Read'),
      makeToolEvent(3, 'Glob'),
      makeToolEvent(4, 'Glob'),
      makeToolEvent(5, 'Glob'),
    ];
    const items = groupTimelineItems(events);
    assert.equal(items.length, 2);
    assert.equal(items[0].type, 'tool-group');
    assert.equal(items[1].type, 'tool-group');
    if (items[0].type === 'tool-group' && items[1].type === 'tool-group') {
      assert.equal(items[0].events.length, 2, 'first group should have 2 Read calls');
      assert.equal(items[0].events[0].tool_name, 'Read');
      assert.equal(items[1].events.length, 3, 'second group should have 3 Glob calls');
      assert.equal(items[1].events[0].tool_name, 'Glob');
    }
  });

  it('keeps single tool call as standalone event', () => {
    const events = [
      makeToolEvent(1, 'Read'),
    ];
    const items = groupTimelineItems(events);
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'event');
  });

  it('handles mixed tool and non-tool events', () => {
    const events = [
      makeEvent(1, 'assistant_message'),
      makeToolEvent(2, 'Read'),
      makeToolEvent(3, 'Read'),
      makeEvent(4, 'user_message'),
      makeToolEvent(5, 'Bash'),
    ];
    const items = groupTimelineItems(events);
    assert.equal(items.length, 4);
    assert.equal(items[0].type, 'event');        // assistant_message
    assert.equal(items[1].type, 'tool-group');    // 2x Read
    assert.equal(items[2].type, 'event');         // user_message
    assert.equal(items[3].type, 'event');         // single Bash
  });

  it('does not group tool calls across a non-tool event boundary', () => {
    const events = [
      makeToolEvent(1, 'Read'),
      makeToolEvent(2, 'Read'),
      makeEvent(3, 'assistant_message'),
      makeToolEvent(4, 'Read'),
      makeToolEvent(5, 'Read'),
    ];
    const items = groupTimelineItems(events);
    assert.equal(items.length, 3);
    assert.equal(items[0].type, 'tool-group');
    assert.equal(items[1].type, 'event');
    assert.equal(items[2].type, 'tool-group');
  });

  it('renders compaction events as standalone', () => {
    const events = [
      makeToolEvent(1, 'Read'),
      makeEvent(2, 'compaction'),
      makeToolEvent(3, 'Read'),
    ];
    const items = groupTimelineItems(events);
    assert.equal(items.length, 3);
    assert.equal(items[0].type, 'event');
    assert.equal(items[1].type, 'compaction');
    assert.equal(items[2].type, 'event');
  });

  it('skips agent_id events (subagent filtering)', () => {
    const events = [
      makeToolEvent(1, 'Read'),
      makeToolEvent(2, 'Read', { agent_id: 'agent-1' }),
      makeToolEvent(3, 'Read'),
    ];
    const items = groupTimelineItems(events);
    // agent_id event is skipped, leaving two non-consecutive Reads → 2 standalone events
    assert.equal(items.length, 2);
    assert.ok(items.every(i => i.type === 'event'));
  });
});

// ─── transformTimeline (annotation alignment) ──────────

describe('transformTimeline annotation alignment', () => {
  function makePoint(timestamp: string, context_pct = 30): TokenDataPoint {
    return {
      timestamp,
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 10,
      cache_write_tokens: 5,
      context_pct,
      event_type: 'assistant_message',
      is_compaction: false,
    };
  }

  it('resolves each annotation timestamp to the nearest timeline index (Behavior #6)', () => {
    const timeline = [
      makePoint('2026-01-15T10:00:00Z'),
      makePoint('2026-01-15T10:01:00Z'),
      makePoint('2026-01-15T10:02:00Z'),
    ];
    // This annotation's timestamp is closest to the middle point (index 1).
    const annotations: EventAnnotation[] = [
      {
        timestamp: '2026-01-15T10:01:05Z',
        marker_type: 'file_read',
        tool_name: 'Read',
        label: '/tmp/foo.ts',
      },
    ];
    const data = transformTimeline(timeline, 200000, annotations);
    assert.equal(data.annotations.length, 1);
    assert.equal(data.annotations[0].index, 1, 'nearest point is the middle one');
    assert.equal(data.annotations[0].tool_name, 'Read');
  });

  it('resolves an annotation past the last point to the final index', () => {
    const timeline = [
      makePoint('2026-01-15T10:00:00Z'),
      makePoint('2026-01-15T10:01:00Z'),
    ];
    const annotations: EventAnnotation[] = [
      { timestamp: '2026-01-15T10:05:00Z', marker_type: 'bash', tool_name: 'Bash', label: 'npm test' },
    ];
    const data = transformTimeline(timeline, 200000, annotations);
    assert.equal(data.annotations[0].index, 1, 'later-than-all annotation snaps to last index');
  });
});

// ─── TokenBudgetSummary ─────────────────────────────────

describe('TokenBudgetSummary', () => {
  function makeBudget(overrides: Partial<TokenBudget> = {}): TokenBudget {
    return {
      billed_tokens: 1500,
      cost_total: 1.2345,
      parent: { tokens: 1000, cost: 0.9, pct: 67 },
      agents: { tokens: 500, cost: 0.33, runs: 1, pct: 33 },
      by_type: [],
      context_peak: { pct: 42, peak_tokens: 120000, max_tokens: 200000 },
      ...overrides,
    };
  }

  it('renders the cost half with dollar amount and token total', () => {
    const out = render(html`<${TokenBudgetSummary} budget=${makeBudget()} model=${'sonnet'} />`);
    assert.ok(out.includes('token-budget-summary'), 'should render the container');
    assert.ok(out.includes('COST'), 'should label the cost half');
    assert.ok(out.includes('$1.23'), 'cost should be formatted to two decimals');
    assert.ok(out.includes('1.5K tokens'), 'billed tokens should use the K formatter');
  });

  it('shows an em dash when the model is unpriced (cost_total null)', () => {
    const out = render(html`<${TokenBudgetSummary} budget=${makeBudget({ cost_total: null })} model=${'sonnet'} />`);
    assert.ok(out.includes('—'), 'null cost should render the em dash placeholder');
    assert.ok(!out.includes('$'), 'no dollar sign when cost is null');
  });

  it('rounds the context-peak percentage and shows absolute peak / max', () => {
    const out = render(html`<${TokenBudgetSummary} budget=${makeBudget({ context_peak: { pct: 42.6, peak_tokens: 120000, max_tokens: 200000 } })} model=${'sonnet'} />`);
    assert.ok(out.includes('43%'), 'peak pct should be rounded');
    assert.ok(out.includes('120.0K / 200.0K'), 'should show peak / max absolute tokens');
  });

  it('clamps the fill width at 100% when peak exceeds the window', () => {
    const out = render(html`<${TokenBudgetSummary} budget=${makeBudget({ context_peak: { pct: 130, peak_tokens: 260000, max_tokens: 200000 } })} model=${'sonnet'} />`);
    assert.ok(out.includes('width:100%'), 'fill width should cap at 100%');
    assert.ok(out.includes('130%'), 'the numeric label still reflects the real (uncapped) pct');
  });

  it('places danger and auto-compact ticks at the model thresholds', () => {
    const out = render(html`<${TokenBudgetSummary} budget=${makeBudget()} model=${'sonnet'} />`);
    assert.ok(out.includes('tbs-tick-danger'), 'should render the danger tick');
    assert.ok(out.includes('left:75%'), 'sonnet danger threshold is 75%');
    assert.ok(out.includes('tbs-tick-autocompact'), 'should render the auto-compact tick');
    assert.ok(out.includes('left:83.5%'), 'sonnet auto-compact threshold is 83.5%');
  });

  it('ramps the accent color with peak severity', () => {
    const safe = render(html`<${TokenBudgetSummary} budget=${makeBudget({ context_peak: { pct: 20, peak_tokens: 40000, max_tokens: 200000 } })} model=${'sonnet'} />`);
    assert.ok(safe.includes('var(--color-ctx-safe-text)'), 'low peak should use the safe token');
    const warn = render(html`<${TokenBudgetSummary} budget=${makeBudget({ context_peak: { pct: 55, peak_tokens: 110000, max_tokens: 200000 } })} model=${'sonnet'} />`);
    assert.ok(warn.includes('var(--color-ctx-warn-text)'), 'mid peak should use the warn token');
    const danger = render(html`<${TokenBudgetSummary} budget=${makeBudget({ context_peak: { pct: 85, peak_tokens: 170000, max_tokens: 200000 } })} model=${'sonnet'} />`);
    assert.ok(danger.includes('var(--color-ctx-danger-text)'), 'high peak should use the danger token');
  });

  it('renders cleanly with a null model (falls back to default thresholds)', () => {
    const out = render(html`<${TokenBudgetSummary} budget=${makeBudget()} model=${null} />`);
    assert.ok(out.includes('token-budget-summary'), 'should still render the bar with no model');
    assert.ok(out.includes('CONTEXT PEAK'), 'should label the context half');
  });
});

// ─── Dropdown ───────────────────────────────────────────

const dropdownOpts = [
  { value: 'a', label: 'Option A' },
  { value: 'b', label: 'Option B' },
  { value: 'c', label: 'Option C', swatch: '#ff0000' },
];

describe('Dropdown', () => {
  it('renders trigger button with label and caret', () => {
    const out = render(html`<${Dropdown} label="Pick one" options=${dropdownOpts} value="a" onChange=${() => {}} />`);
    assert.ok(out.includes('dd-trigger'), 'should render trigger');
    assert.ok(out.includes('Pick one'), 'should show label');
    assert.ok(out.includes('dd-caret'), 'should render caret');
  });

  it('does not render popover when closed by default', () => {
    const out = render(html`<${Dropdown} label="Pick one" options=${dropdownOpts} value="a" onChange=${() => {}} />`);
    assert.ok(!out.includes('dd-popover'), 'popover should not render when closed');
  });

  it('renders popover when defaultOpen=true', () => {
    const out = render(html`<${Dropdown} label="Pick one" options=${dropdownOpts} value="a" onChange=${() => {}} defaultOpen=${true} />`);
    assert.ok(out.includes('dd-popover'), 'popover should render when defaultOpen');
    assert.ok(out.includes('Option A'), 'options should be listed');
  });

  it('marks selected option with dd-option-selected', () => {
    const out = render(html`<${Dropdown} label="Pick one" options=${dropdownOpts} value="b" onChange=${() => {}} defaultOpen=${true} />`);
    assert.ok(out.includes('dd-option-selected'), 'selected class should appear');
    const selectedPos = out.indexOf('dd-option-selected');
    const bPos = out.indexOf('Option B');
    assert.ok(Math.abs(selectedPos - bPos) < 150, 'selected class should be near Option B');
  });

  it('renders swatch for option with swatch defined', () => {
    const out = render(html`<${Dropdown} label="Pick one" options=${dropdownOpts} value="a" onChange=${() => {}} defaultOpen=${true} />`);
    assert.ok(out.includes('dd-swatch'), 'swatch span should render for option with color');
    assert.ok(out.includes('#ff0000'), 'swatch should carry the color value');
  });

  it('renders typeahead input when typeahead=true', () => {
    const out = render(html`<${Dropdown} label="Pick one" options=${dropdownOpts} value="a" onChange=${() => {}} defaultOpen=${true} typeahead=${true} />`);
    assert.ok(out.includes('dd-search'), 'typeahead input should render');
  });

  it('does not render typeahead input when typeahead=false', () => {
    const out = render(html`<${Dropdown} label="Pick one" options=${dropdownOpts} value="a" onChange=${() => {}} defaultOpen=${true} typeahead=${false} />`);
    assert.ok(!out.includes('dd-search'), 'no search input when typeahead disabled');
  });
});

// ─── FilterBar ──────────────────────────────────────────

const baseFilterBarProps = {
  searchQuery: '',
  onSearch: () => {},
  projects: [] as ProjectInfo[],
  selectedProject: null,
  onSelectProject: () => {},
  modelFilter: 'all',
  onModelFilter: () => {},
  sortCol: 'started_at',
  sortOrder: 'desc',
  onApplySort: () => {},
  total: 42,
  loading: false,
  hasActiveFilters: false,
  onResetFilters: () => {},
};

describe('FilterBar', () => {
  it('renders search input', () => {
    const out = render(html`<${FilterBar} ...${baseFilterBarProps} />`);
    assert.ok(out.includes('search-input'), 'should render search input');
  });

  it('renders three dropdown triggers', () => {
    const out = render(html`<${FilterBar} ...${baseFilterBarProps} />`);
    const count = (out.match(/class="dd-trigger"/g) ?? []).length;
    assert.equal(count, 3, 'should render project, model, and sort dropdowns');
  });

  it('shows result count badge with correct total', () => {
    const out = render(html`<${FilterBar} ...${baseFilterBarProps} />`);
    assert.ok(out.includes('filter-bar-count'), 'should show count badge');
    assert.ok(out.includes('42'), 'should show total count');
  });

  it('count badge has pulse class while loading', () => {
    const out = render(html`<${FilterBar} ...${baseFilterBarProps} loading=${true} />`);
    assert.ok(out.includes('filter-bar-count-pulse'), 'should add pulse class while loading');
  });

  it('does not show Clear filters button when no active filters', () => {
    const out = render(html`<${FilterBar} ...${baseFilterBarProps} hasActiveFilters=${false} />`);
    assert.ok(!out.includes('reset-filters'), 'no clear button without active filters');
  });

  it('shows Clear filters button when filters are active', () => {
    const out = render(html`<${FilterBar} ...${baseFilterBarProps} hasActiveFilters=${true} />`);
    assert.ok(out.includes('reset-filters'), 'shows clear button with active filters');
    assert.ok(out.includes('Clear filters'), 'button has correct label');
  });

  it('shows selected project name in trigger label', () => {
    const projects: ProjectInfo[] = [
      { project_path: '/work/foo', project_name: 'foo', session_count: 5 },
    ];
    const out = render(html`<${FilterBar} ...${baseFilterBarProps} projects=${projects} selectedProject="/work/foo" />`);
    assert.ok(out.includes('foo'), 'should show selected project name in trigger');
  });

  it('reflects model filter in trigger label', () => {
    const out = render(html`<${FilterBar} ...${baseFilterBarProps} modelFilter="opus" />`);
    assert.ok(out.includes('Opus'), 'should show model name in trigger');
  });

  it('reflects sort selection in trigger label', () => {
    const out = render(html`<${FilterBar} ...${baseFilterBarProps} sortCol="duration_ms" sortOrder="desc" />`);
    assert.ok(out.includes('Longest duration'), 'should show sort label in trigger');
  });

  it('shows ellipsis placeholder in count while loading', () => {
    const out = render(html`<${FilterBar} ...${baseFilterBarProps} loading=${true} total=${0} />`);
    assert.ok(out.includes('…'), 'should show ellipsis while loading');
  });
});

// ─── ExportButton ───────────────────────────────────────

describe('ExportButton', () => {
  it('renders the primary button with the "Export (raw)" label', () => {
    const out = render(html`<${ExportButton} sessionId=${'sess-1'} />`);
    assert.ok(out.includes('export-btn-primary'), 'should render the primary button');
    assert.ok(out.includes('Export (raw)'), 'primary label names the default (raw) mode');
    assert.ok(out.includes('copy-btn'), 'should sit at the .copy-btn pill scale');
  });

  it('renders the caret button', () => {
    const out = render(html`<${ExportButton} sessionId=${'sess-1'} />`);
    assert.ok(out.includes('export-btn-caret'), 'should render the caret toggle');
  });

  it('does not render the menu when closed by default', () => {
    const out = render(html`<${ExportButton} sessionId=${'sess-1'} />`);
    assert.ok(!out.includes('export-btn-menu'), 'menu should not render when closed');
  });

  it('renders both mode options when defaultMenuOpen=true', () => {
    const out = render(html`<${ExportButton} sessionId=${'sess-1'} defaultMenuOpen=${true} />`);
    assert.ok(out.includes('export-btn-menu'), 'menu should render when defaultMenuOpen');
    assert.ok(out.includes('Raw (unsanitized)'), 'menu should list the raw option');
    assert.ok(out.includes('Sanitized'), 'menu should list the sanitized option');
  });
});
