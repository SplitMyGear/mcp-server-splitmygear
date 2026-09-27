/**
 * Tool results as text an assistant can afford to read.
 *
 * COMPACT JSON. Every tool result lands in the model's context, and an
 * indented dump spends a quarter to a third of its characters on whitespace.
 *
 * A SIZE BUDGET. Claude Code stops at 25,000 tokens per tool result by
 * default (MAX_MCP_OUTPUT_TOKENS) and claude.ai at about 150,000 characters
 * (claude.com/docs/connectors/building, "size and timeout limits"); a vendor
 * with a large catalogue or booking history can pass both with one list call,
 * and the client then drops or mangles the result. So a result over
 * `MAX_RESULT_CHARS` keeps the LARGEST list it carries (the value itself, or
 * one of its own properties) cut to what fits, and says so in a
 * `resultTruncated` member (field, returned, total, what to do), so the JSON
 * stays valid and the model knows to page or narrow. A result with no list to
 * shorten is cut at the limit with the same notice.
 */

/** ~15-20k tokens of JSON: under Claude Code's default cap, far under claude.ai's. */
export const MAX_RESULT_CHARS = 60_000;

const NOTE =
  'Result shortened to fit the assistant. Ask for fewer items (a limit, an offset or a filter) or open one item by its id.';

interface Truncation {
  field?: string;
  returned: number;
  total: number;
  note: string;
}

export function toResultText(data: unknown, max: number = MAX_RESULT_CHARS): string {
  if (typeof data === 'string') return capText(data, max);
  const text = JSON.stringify(data) ?? 'null';
  if (text.length <= max) return text;
  return shortenLargestList(data, max) ?? capText(text, max);
}

function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const hidden = (n: number) => `\n...[${n} more characters not shown. ${NOTE}]`;
  // The notice itself takes room: size the cut so text + notice fits.
  let keep = Math.max(0, max - hidden(text.length).length);
  keep = Math.max(0, max - hidden(text.length - keep).length);
  return text.slice(0, keep) + hidden(text.length - keep);
}

function shortenLargestList(data: unknown, max: number): string | null {
  if (Array.isArray(data)) {
    return fit(data, (items, t) => ({ items, resultTruncated: t }), max);
  }
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  let largest: { key: string; list: unknown[]; size: number } | null = null;
  for (const [key, value] of Object.entries(record)) {
    if (!Array.isArray(value)) continue;
    const size = JSON.stringify(value).length;
    if (!largest || size > largest.size) largest = { key, list: value, size };
  }
  if (!largest) return null;
  const { key, list } = largest;
  return fit(list, (items, t) => ({ ...record, [key]: items, resultTruncated: { field: key, ...t } }), max);
}

/** The longest prefix of `list` whose rendering fits, or null when not even an empty list fits. */
function fit(list: unknown[], render: (items: unknown[], t: Truncation) => unknown, max: number): string | null {
  const draw = (n: number) => JSON.stringify(render(list.slice(0, n), { returned: n, total: list.length, note: NOTE }));
  let lo = 0;
  let hi = list.length - 1;
  let best: string | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const text = draw(mid);
    if (text.length <= max) {
      best = text;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
