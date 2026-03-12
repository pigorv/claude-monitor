import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import render from 'preact-render-to-string';
import { html } from 'htm/preact';
import { Sparkline } from '../../frontend/src/components/Sparkline.js';
import { Heatmap } from '../../frontend/src/components/Heatmap.js';
import { EventCard } from '../../frontend/src/components/EventCard.js';
import { AgentTree } from '../../frontend/src/components/AgentTree.js';
import type { Event as SessionEvent, AgentRelationship, TokenDataPoint } from '../../src/shared/types.js';

// ─── Sparkline ──────────────────────────────────────────

describe('Sparkline', () => {
  it('renders placeholder for empty data', () => {
    const out = render(html`<${Sparkline} data=${[]} />`);
    assert.ok(out.includes('—'), 'should render dash placeholder');
  });

  it('renders placeholder for undefined data', () => {
    const out = render(html`<${Sparkline} data=${undefined as any} />`);
    assert.ok(out.includes('—'));
  });

  it('renders SVG polyline for valid data', () => {
    const data = [
      { context_pct: 10, is_compaction: false },
      { context_pct: 25, is_compaction: false },
      { context_pct: 15, is_compaction: false },
    ];
    const out = render(html`<${Sparkline} data=${data} />`);
    assert.ok(out.includes('<svg'), 'should render SVG element');
    assert.ok(out.includes('<polyline'), 'should render polyline');
    assert.ok(out.includes('points='), 'should have points attribute');
  });

  it('uses green stroke for low context', () => {
    const data = [{ context_pct: 10, is_compaction: false }];
    const out = render(html`<${Sparkline} data=${data} />`);
    assert.ok(out.includes('var(--green)'), 'peak < 30% → green');
  });

  it('uses yellow stroke for medium context', () => {
    const data = [
      { context_pct: 10, is_compaction: false },
      { context_pct: 45, is_compaction: false },
    ];
    const out = render(html`<${Sparkline} data=${data} />`);
    assert.ok(out.includes('var(--yellow)'), 'peak 30-60% → yellow');
  });

  it('uses red stroke for high context', () => {
    const data = [{ context_pct: 80, is_compaction: false }];
    const out = render(html`<${Sparkline} data=${data} />`);
    assert.ok(out.includes('var(--red)'), 'peak >= 60% → red');
  });

  it('respects custom width and height', () => {
    const data = [{ context_pct: 10, is_compaction: false }];
    const out = render(html`<${Sparkline} data=${data} width=${100} height=${40} />`);
    assert.ok(out.includes('0 0 100 40'), 'viewBox should use custom dimensions');
  });

  it('handles single data point', () => {
    const data = [{ context_pct: 50, is_compaction: false }];
    const out = render(html`<${Sparkline} data=${data} />`);
    assert.ok(out.includes('<polyline'), 'single point should still render');
  });
});

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
    assert.ok(out.includes('#ef4444'), 'high context should use red');
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

  it('renders assistant message with pill badge', () => {
    const out = render(html`<${EventCard} event=${makeEvent()} />`);
    assert.ok(out.includes('event-card'), 'should have event-card class');
    assert.ok(out.includes('pill-purple'), 'assistant should use purple pill');
    assert.ok(out.includes('Assistant'), 'should show type label');
  });

  it('renders user message type', () => {
    const evt = makeEvent({ event_type: 'user_message', input_preview: 'Fix bug' });
    const out = render(html`<${EventCard} event=${evt} />`);
    assert.ok(out.includes('pill-blue'), 'user should use blue pill');
    assert.ok(out.includes('User'), 'should show User label');
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
      context_pct: 85,
    });
    const out = render(html`<${EventCard} event=${evt} />`);
    assert.ok(out.includes('compaction-banner'), 'should render compaction banner');
    assert.ok(out.includes('Auto-compaction triggered'), 'should show title');
    assert.ok(out.includes('500.0K'), 'should show before tokens');
    assert.ok(out.includes('200.0K'), 'should show after tokens');
    assert.ok(out.includes('85% ctx'), 'should show context percentage');
  });

  it('renders thinking event with summary preview', () => {
    const evt = makeEvent({
      event_type: 'thinking',
      thinking_summary: 'Analyzing the code...',
      thinking_text: 'Full thinking content here',
    });
    const out = render(html`<${EventCard} event=${evt} />`);
    assert.ok(out.includes('pill-yellow'), 'thinking should use yellow pill');
    assert.ok(out.includes('Analyzing the code...'), 'should show summary in collapsed state');
  });

  it('renders context mini-bar with correct color', () => {
    const evt = makeEvent({ context_pct: 75 });
    const out = render(html`<${EventCard} event=${evt} />`);
    assert.ok(out.includes('ctx-minibar'), 'should render context minibar');
    assert.ok(out.includes('75%'), 'should show percentage');
    assert.ok(out.includes('var(--red)'), 'context >= 70% should be red');
  });

  it('renders context mini-bar green for low context', () => {
    const evt = makeEvent({ context_pct: 15 });
    const out = render(html`<${EventCard} event=${evt} />`);
    assert.ok(out.includes('var(--green)'), 'context < 30% should be green');
  });

  it('renders agent ID when present', () => {
    const evt = makeEvent({ agent_id: 'agent-abc123def456' });
    const out = render(html`<${EventCard} event=${evt} />`);
    assert.ok(out.includes('event-agent'), 'should render agent span');
    assert.ok(out.includes('agent:agent-abc123'), 'should truncate agent ID to 12 chars');
  });

  it('renders duration when present', () => {
    const evt = makeEvent({ duration_ms: 2500 });
    const out = render(html`<${EventCard} event=${evt} />`);
    assert.ok(out.includes('2.5s'), 'should format duration');
  });

  it('renders relative time from session start', () => {
    const evt = makeEvent({ timestamp: '2026-01-15T10:05:30Z' });
    const out = render(html`<${EventCard} event=${evt} sessionStart=${'2026-01-15T10:00:00Z'} />`);
    assert.ok(out.includes('+5m30s'), 'should show relative time');
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
      assert.ok(out.includes('event-card'), `${t} should render event-card`);
    }
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

  it('renders agent table with data', () => {
    const agents = [makeAgent()];
    const out = render(html`<${AgentTree} agents=${agents} sessionStart=${'2026-01-15T10:00:00Z'} />`);
    assert.ok(out.includes('agent-table'), 'should render table');
    assert.ok(out.includes('agent-abc123'), 'should show agent ID');
    assert.ok(out.includes('completed'), 'should show status');
    assert.ok(out.includes('Search for the user model'), 'should show description from prompt preview');
  });

  it('renders summary with token totals', () => {
    const agents = [makeAgent()];
    const out = render(html`<${AgentTree} agents=${agents} />`);
    assert.ok(out.includes('70.0K'), 'should show combined tokens');
    assert.ok(out.includes('tokens consumed'), 'should label tokens');
    assert.ok(out.includes('8'), 'should show tool call count');
  });

  it('renders token flow arrows in table', () => {
    const agents = [makeAgent()];
    const out = render(html`<${AgentTree} agents=${agents} />`);
    assert.ok(out.includes('50.0K'), 'should show input tokens');
    assert.ok(out.includes('20.0K'), 'should show output tokens');
    assert.ok(out.includes('token-flow'), 'should have token flow element');
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

  it('green for context < 30%', () => {
    const out = render(html`<${EventCard} event=${makeEvent(20)} />`);
    assert.ok(out.includes('var(--green)'));
  });

  it('yellow for context 30-60%', () => {
    const out = render(html`<${EventCard} event=${makeEvent(45)} />`);
    assert.ok(out.includes('var(--yellow)'));
  });

  it('orange for context 60-70%', () => {
    const out = render(html`<${EventCard} event=${makeEvent(65)} />`);
    assert.ok(out.includes('var(--orange)'));
  });

  it('red for context >= 70%', () => {
    const out = render(html`<${EventCard} event=${makeEvent(85)} />`);
    assert.ok(out.includes('var(--red)'));
  });

  it('caps bar width at 100%', () => {
    const out = render(html`<${EventCard} event=${makeEvent(120)} />`);
    assert.ok(out.includes('width: 100%'), 'should cap at 100% width');
  });
});
