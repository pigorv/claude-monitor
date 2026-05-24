import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  parseAskOutput,
  normalizeAnswerValues,
  type AskQuestion,
} from '../../frontend/src/components/EventCard.js';

// The Anthropic SDK serializes AskUserQuestion answers in several distinct
// shapes; this suite locks in the parser's behavior against the formats
// observed in real session JSONL (see DB survey in PR #54).

describe('parseAskOutput — JSON shapes (forward-compat)', () => {
  it('returns the parsed object for {answers, annotations} JSON', () => {
    const raw = JSON.stringify({
      answers: { 'Library?': 'date-fns' },
      annotations: { 'Library?': { notes: 'fastest' } },
    });
    const out = parseAskOutput(raw, [{ question: 'Library?' }]);
    assert.deepEqual(out, {
      answers: { 'Library?': 'date-fns' },
      annotations: { 'Library?': { notes: 'fastest' } },
    });
  });

  it('unwraps stringified content-block array shape', () => {
    const raw = JSON.stringify([
      { type: 'text', text: JSON.stringify({ answers: { Q: 'A' } }) },
    ]);
    const out = parseAskOutput(raw, [{ question: 'Q' }]);
    assert.deepEqual(out, { answers: { Q: 'A' } });
  });

  it('returns null when JSON has no answers key', () => {
    const raw = JSON.stringify({ something: 'else' });
    assert.equal(parseAskOutput(raw, [{ question: 'Q' }]), null);
  });
});

describe('parseAskOutput — "User has answered…" form (real common case)', () => {
  it('extracts a single Q→A pair', () => {
    const raw = 'User has answered your questions: "What library?"="date-fns". You can now continue with the user\'s answers in mind.';
    const out = parseAskOutput(raw, [{ question: 'What library?' }]);
    assert.deepEqual(out?.answers, { 'What library?': 'date-fns' });
  });

  it('extracts multiple comma-separated Q→A pairs', () => {
    const raw = 'User has answered your questions: "Library?"="date-fns", "Format?"="ISO". You can now continue.';
    const out = parseAskOutput(raw, [
      { question: 'Library?' },
      { question: 'Format?' },
    ]);
    assert.deepEqual(out?.answers, { 'Library?': 'date-fns', 'Format?': 'ISO' });
  });

  it('also matches the "Your questions have been answered:" variant', () => {
    const raw = 'Your questions have been answered: "Q1"="A1". You can now continue.';
    const out = parseAskOutput(raw, [{ question: 'Q1' }]);
    assert.deepEqual(out?.answers, { Q1: 'A1' });
  });

  it('handles unescaped quotes inside question text', () => {
    // The real-world session had questions like `how should "all" map to…`
    const raw = 'User has answered your questions: "how should "all" map to the SDK?"="Expand to list". You can now continue.';
    const out = parseAskOutput(raw, [{ question: 'how should "all" map to the SDK?' }]);
    assert.deepEqual(out?.answers, { 'how should "all" map to the SDK?': 'Expand to list' });
  });

  it('handles unescaped quotes inside answer text', () => {
    const raw = 'User has answered your questions: "Q1"="use "strict" mode". You can now continue.';
    const out = parseAskOutput(raw, [{ question: 'Q1' }]);
    assert.deepEqual(out?.answers, { Q1: 'use "strict" mode' });
  });

  it('tolerates a " selected preview:" free-text block between Q/A pairs', () => {
    // Mirrors the real session a1a6ebab… raw output (manifest preview slug).
    const raw = 'User has answered your questions: "Q1"="opt-A" selected preview:\nmanifest:  allowed: "all"\nmore lines\n(stuff), "Q2"="opt-B". You can now continue.';
    const out = parseAskOutput(raw, [{ question: 'Q1' }, { question: 'Q2' }]);
    assert.deepEqual(out?.answers, { Q1: 'opt-A', Q2: 'opt-B' });
  });

  it('returns null when no input questions appear in the output', () => {
    const raw = 'User has answered your questions: "Other?"="value". You can now continue.';
    const out = parseAskOutput(raw, [{ question: 'Q1' }, { question: 'Q2' }]);
    assert.equal(out, null);
  });

  it('omits questions absent from the output (so they classify as skipped)', () => {
    const raw = 'User has answered your questions: "Q1"="A1". You can now continue.';
    const out = parseAskOutput(raw, [{ question: 'Q1' }, { question: 'Q2' }]);
    assert.deepEqual(out?.answers, { Q1: 'A1' });
  });

  it('preserves " (Recommended)" suffix in answer — it is part of the option label, not an annotation', () => {
    const raw = 'User has answered your questions: "Q1"="opt-A (Recommended)". You can now continue.';
    const out = parseAskOutput(raw, [{ question: 'Q1' }]);
    assert.deepEqual(out?.answers, { Q1: 'opt-A (Recommended)' });
  });

  it('splits comma-joined answers into an array when q.multiSelect is true', () => {
    const raw = 'User has answered your questions: "Features?"="A,B,C". You can now continue.';
    const out = parseAskOutput(raw, [{ question: 'Features?', multiSelect: true }]);
    assert.deepEqual(out?.answers, { 'Features?': ['A', 'B', 'C'] });
  });

  it('keeps comma-bearing answers as one string when q.multiSelect is false', () => {
    const raw = 'User has answered your questions: "Q1"="a, b, and c". You can now continue.';
    const out = parseAskOutput(raw, [{ question: 'Q1' }]);
    assert.deepEqual(out?.answers, { Q1: 'a, b, and c' });
  });
});

describe('parseAskOutput — rejection / clarify form', () => {
  it('extracts partial answers from "Questions asked:" bullets', () => {
    const raw =
      "The user doesn't want to proceed with this tool use. " +
      "Some preamble.\n\n" +
      "    Questions asked:\n" +
      "- \"Q1\"\n" +
      "  Answer: opt-A\n" +
      "- \"Q2\"\n" +
      "  Answer: opt-B (Recommended)\n" +
      "- \"Q3\"\n" +
      "  (No answer provided)\n\n" +
      "Note: trailing stuff.";
    const out = parseAskOutput(raw, [
      { question: 'Q1' },
      { question: 'Q2' },
      { question: 'Q3' },
    ]);
    // Q1 and Q2 answered; Q3 omitted (classifies as skipped).
    // " (Recommended)" stays as part of the answer — it's part of the option
    // label the SDK echoes verbatim, not an annotation to strip.
    assert.deepEqual(out?.answers, { Q1: 'opt-A', Q2: 'opt-B (Recommended)' });
  });

  it('handles unescaped quotes in rejected-form question text', () => {
    const raw =
      "The user doesn't want to proceed with this tool use.\n\n" +
      "    Questions asked:\n" +
      "- \"How should \"all\" map?\"\n" +
      "  Answer: expand\n";
    const out = parseAskOutput(raw, [{ question: 'How should "all" map?' }]);
    assert.deepEqual(out?.answers, { 'How should "all" map?': 'expand' });
  });
});

describe('parseAskOutput — tool errors and null inputs', () => {
  it('returns null for null input', () => {
    assert.equal(parseAskOutput(null, []), null);
  });

  it('returns null for <tool_use_error> prefix', () => {
    const raw = '<tool_use_error>InputValidationError: bad questions array</tool_use_error>';
    assert.equal(parseAskOutput(raw, [{ question: 'Q' }]), null);
  });

  it('returns null for "Tool permission" prefix', () => {
    const raw = 'Tool permission stream closed before response';
    assert.equal(parseAskOutput(raw, [{ question: 'Q' }]), null);
  });

  it('returns null for fully unknown shape', () => {
    const raw = 'something completely different';
    assert.equal(parseAskOutput(raw, [{ question: 'Q' }]), null);
  });
});

describe('normalizeAnswerValues', () => {
  it('returns [] for null/undefined', () => {
    assert.deepEqual(normalizeAnswerValues(null), []);
    assert.deepEqual(normalizeAnswerValues(undefined), []);
  });
  it('wraps a string in an array', () => {
    assert.deepEqual(normalizeAnswerValues('hello'), ['hello']);
  });
  it('filters non-strings from arrays', () => {
    assert.deepEqual(normalizeAnswerValues(['a', 1 as unknown, 'b']), ['a', 'b']);
  });
});
