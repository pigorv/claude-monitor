// Pure parser + formatter for AskUserQuestion tool results. Lives in lib/ so
// it can be unit-tested without a DOM environment; EventCard.tsx is the only
// DOM-bound consumer. Mirrors the lib/selection.ts and lib/url-state.ts split:
// pure logic here, render glue in the component.

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: Array<{ label: string; description?: string }>;
}
export type AskAnswerValue = string | string[];
export interface AskAnswers {
  answers: Record<string, AskAnswerValue>;
  annotations?: Record<string, { notes?: string } | undefined>;
}

function tryParseJson(s: string | null): Record<string, unknown> | null {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Parse the tool_result body for AskUserQuestion. The SDK emits answers in
// several distinct shapes; we anchor on the known input questions so unescaped
// quotes/commas inside answers don't break the scan. Never throws.
//
// Shapes handled (first match wins):
//   1. Direct {answers, annotations} JSON object
//   2. Stringified content-block array [{type:"text", text:"<json>"}]
//   3. "User has answered your questions: "Q"="A", …" / "Your questions have
//      been answered: …" — the common ~98% case
//   4. "The user doesn't want to proceed… Questions asked:\n- "Q"\n  Answer: A"
//   5. Tool errors (<tool_use_error>, Tool permission…) — returns null so the
//      existing `isErr` render path handles it
export function parseAskOutput(raw: string | null, questions: AskQuestion[]): AskAnswers | null {
  if (!raw) return null;

  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        if (obj.answers && typeof obj.answers === "object") return obj as unknown as AskAnswers;
      } else if (Array.isArray(parsed)) {
        for (const block of parsed) {
          if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
            const txt = (block as Record<string, unknown>).text;
            if (typeof txt === "string") {
              const inner = tryParseJson(txt);
              if (inner && "answers" in inner && inner.answers && typeof inner.answers === "object") {
                return inner as unknown as AskAnswers;
              }
            }
          }
        }
      }
    } catch { /* not JSON; fall through */ }
  }

  if (raw.startsWith("<tool_use_error>") || raw.startsWith("Tool permission")) return null;

  if (raw.startsWith("User has answered your questions:")
      || raw.startsWith("Your questions have been answered:")) {
    return parseAnsweredForm(raw, questions);
  }

  if (raw.startsWith("The user doesn't want to proceed") || raw.includes("Questions asked:")) {
    return parseRejectedForm(raw, questions);
  }

  return null;
}

// Split a multi-select answer string into its constituent picks. When the
// question's option list is known, greedy-match the longest labels first so
// labels that legitimately contain `,` (e.g. "enhancement, frontend, ux")
// survive intact instead of being shredded by a naive comma split. Unmatched
// remainders are still comma-split — those are the user's custom values.
export function splitMultiSelectAnswer(ans: string, q: AskQuestion): string[] {
  const optList = Array.isArray(q.options) ? q.options : [];
  if (optList.length === 0) {
    return ans.split(",").map(s => s.trim()).filter(Boolean);
  }
  const labels = optList.map(o => o.label).sort((a, b) => b.length - a.length);
  const result: string[] = [];
  let remaining = ans.trim();
  while (remaining.length > 0) {
    let matched = false;
    for (const label of labels) {
      if (remaining === label || remaining.startsWith(label + ",")) {
        result.push(label);
        remaining = remaining.slice(label.length).replace(/^,\s*/, "");
        matched = true;
        break;
      }
    }
    if (matched) continue;
    const comma = remaining.indexOf(",");
    if (comma < 0) {
      const tail = remaining.trim();
      if (tail) result.push(tail);
      break;
    }
    const frag = remaining.slice(0, comma).trim();
    if (frag) result.push(frag);
    remaining = remaining.slice(comma + 1).trimStart();
  }
  return result;
}

function parseAnsweredForm(raw: string, questions: AskQuestion[]): AskAnswers | null {
  const answers: Record<string, AskAnswerValue> = {};
  for (const q of questions) {
    const escQ = escapeRegex(q.question);
    const startMatch = new RegExp(`"${escQ}"\\s*=\\s*"`).exec(raw);
    if (!startMatch) continue;
    const answerStart = startMatch.index + startMatch[0].length;

    // Earliest terminator wins: another known question's "Q"=, the
    // " selected preview:" free-text block, or the trailing ". You can now…"
    const terminators: number[] = [];
    for (const other of questions) {
      if (other.question === q.question) continue;
      const pos = raw.indexOf(`"${other.question}"=`, answerStart);
      if (pos >= 0) terminators.push(pos);
    }
    const preview = raw.indexOf(" selected preview:", answerStart);
    if (preview >= 0) terminators.push(preview);
    const cont = raw.indexOf(". You can now continue", answerStart);
    if (cont >= 0) terminators.push(cont);
    const end = terminators.length > 0 ? Math.min(...terminators) : raw.length;

    // Walk back through trailing `,`/whitespace to the closing `"` of the answer.
    let answerEnd = end;
    while (answerEnd > answerStart && raw[answerEnd - 1] !== '"') answerEnd--;
    if (answerEnd > answerStart) answerEnd--;

    const ans = raw.substring(answerStart, answerEnd).trim();
    if (!ans) continue;

    if (q.multiSelect && ans.includes(",")) {
      answers[q.question] = splitMultiSelectAnswer(ans, q);
    } else {
      answers[q.question] = ans;
    }
  }
  return Object.keys(answers).length > 0 ? { answers } : null;
}

function parseRejectedForm(raw: string, questions: AskQuestion[]): AskAnswers | null {
  const answers: Record<string, AskAnswerValue> = {};
  for (const q of questions) {
    const escQ = escapeRegex(q.question);
    // Answer body runs until the next bullet (`\n- "`), a blank line, or end
    // of input. `[\s\S]+?` lets it span newlines — needed when the user types
    // a multi-line free-form answer via "Other" and then rejects.
    const pattern = new RegExp(
      `-\\s*"${escQ}"\\s*\\n\\s*(?:Answer:\\s*([\\s\\S]+?)(?=\\n\\s*-\\s*"|\\n\\s*\\n|$)|\\(No answer provided\\))`,
    );
    const match = pattern.exec(raw);
    if (!match) continue;
    if (!match[1]) continue; // (No answer provided) → omit, classifies as skipped
    const ans = match[1].trim();
    if (!ans) continue;
    if (q.multiSelect && ans.includes(",")) {
      answers[q.question] = splitMultiSelectAnswer(ans, q);
    } else {
      answers[q.question] = ans;
    }
  }
  return Object.keys(answers).length > 0 ? { answers } : null;
}

// Normalize an answer cell to an array of strings.
export function normalizeAnswerValues(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.filter((v) => typeof v === "string") as string[];
  if (typeof raw === "string") return [raw];
  return [];
}

// Format a single AskUserQuestion entry as plain text for clipboard copy.
// Pure data: question, all options (marking which were selected), and the
// flat list of selected/custom answer values as the SDK recorded them.
export function formatAskQuestionForCopy(
  q: AskQuestion,
  selectedFromOptions: string[],
  customValues: string[],
  note: string | undefined,
): string {
  const lines: string[] = [];
  lines.push(`Q: ${q.question}${q.multiSelect ? " (multi-select)" : ""}`);
  const options = Array.isArray(q.options) ? q.options : [];
  if (options.length > 0) {
    lines.push("Options:");
    for (const opt of options) {
      const mark = selectedFromOptions.includes(opt.label) ? "✓" : "·";
      const desc = opt.description ? ` — ${opt.description}` : "";
      lines.push(`  ${mark} ${opt.label}${desc}`);
    }
  }
  const allPicked = [...selectedFromOptions, ...customValues.map(c => `Custom: ${c}`)];
  if (allPicked.length > 0) lines.push(`A: ${allPicked.join(", ")}`);
  if (note) lines.push(`Note: ${note}`);
  return lines.join("\n");
}
