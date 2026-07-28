// src/renderer/editor/markdownSpanParser.ts
// v3 M10b/post-M10 bugfix: shared parser for the `<span style="...">...</span>` markup that
// `decorationCommands.ts` generates and `markdownDecorations.ts` renders. Factored out into its own
// module so both files agree on exactly one definition of "what counts as a decoration span" —
// this is the fix for Bug A (docs/post-M10-changes.md「Markdown live preview decoration bugs
// (M10b)」): previously `decorationCommands.ts` used its own ad-hoc exact-boundary lookbehind/
// lookahead check (`detectSurroundingSpan`) that disagreed with `markdownDecorations.ts`'s
// non-greedy `SPAN_PATTERN`, so a selection that was a subset of an existing span produced a
// nested `<span>` that the renderer's non-greedy match couldn't parse back correctly (the real
// outer `</span>` leaked as literal text). Using this single shared regex/parser for both
// "what does the live preview treat as a span" and "what does decoration-command range analysis
// treat as an existing span" guarantees round-trip consistency by construction.
//
// Non-goal (developer judgment, same simplification the original code already accepted): this is
// not a real HTML parser. It only recognizes flat (non-nested) `<span style="...">...</span>`
// markup via a non-greedy regex (matches up to the first `</span>` after each `<span ...>`).
// `decorationCommands.ts` is responsible for never generating nested spans going forward (see its
// overlap-safe split/merge design); pre-existing hand-typed or already-corrupted markup containing
// literal `<span`/`</span>`-like substrings that don't form a well-matched pair is treated as plain
// text, same as before.

/** `<span style="...">...</span>`, non-greedy content match (stops at the first `</span>`). */
export const SPAN_PATTERN = /<span\s+style="([^"<>]*)">([\s\S]*?)<\/span>/g;

export const SPAN_CLOSE_TAG = '</span>';

export interface SpanMatch {
  /** Start of the whole `<span ...>...</span>` markup (inclusive). */
  from: number;
  /** End of the whole markup (exclusive). */
  to: number;
  /** Start of the wrapped content, i.e. immediately after the opening tag's `>`. */
  contentFrom: number;
  /** End of the wrapped content, i.e. immediately before `</span>`. */
  contentTo: number;
  /** Raw (unparsed) `style="..."` attribute value. */
  style: string;
}

/** Builds the `<span style="...">` opening tag text for a given (already-serialized) style string. */
export function buildOpenTag(style: string): string {
  return `<span style="${style}">`;
}

/** Finds all top-level (non-nested) `<span style="...">...</span>` matches in `text`, in order. */
export function findSpans(text: string): SpanMatch[] {
  const matches: SpanMatch[] = [];
  SPAN_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SPAN_PATTERN.exec(text))) {
    const style = m[1] ?? '';
    const content = m[2] ?? '';
    const from = m.index;
    const to = from + m[0].length;
    const contentTo = to - SPAN_CLOSE_TAG.length;
    const contentFrom = contentTo - content.length;
    matches.push({ from, to, contentFrom, contentTo, style });
    if (m.index === SPAN_PATTERN.lastIndex) SPAN_PATTERN.lastIndex++; // 空マッチ無限ループの防御（理論上は起きない）。
  }
  return matches;
}
