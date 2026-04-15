// 📂 yua-backend/src/ai/utils/citation-regex.ts
// 🔥 Citation Regex SSOT — backend file citation `[source:filename:section]` parser
//
// - Single source of truth for `[source:...]` tag detection in streaming text.
// - Used by execution-engine to emit real-time FILE_READING activity events
//   as citations fly by in the response delta stream.
// - Mirrors the frontend regex in
//   yua-web/src/view-models/stepProjection.ts (`extractFileSources`).
//
// ⚠️ Regex notes:
// - filename group:  [^:\]]+   → stops at `:` or `]`
// - section  group:  [^\]]+    → greedy up to `]`, so
//                                  `[source:file:part:1]`
//                                  → filename=`file`, section=`part:1`
// - Empty section (`[source:file:]`) is rejected by `+` quantifier.
// - The `g` flag is reset per call (new RegExp instance OR reset lastIndex)
//   to avoid cross-call state bleed.

export const CITATION_PATTERN_SOURCE =
  "\\[source:([^:\\]]+):([^\\]]+)\\]";

/** Fresh global regex. Do NOT export a module-level `g` instance. */
export function buildCitationRegex(): RegExp {
  return new RegExp(CITATION_PATTERN_SOURCE, "g");
}

export type Citation = {
  /** stable dedup key = `${filename}::${section}` */
  id: string;
  filename: string;
  section: string;
};

/**
 * Extract all `[source:filename:section]` citations from a completed string.
 * Deduplicated by `filename::section`.
 */
export function extractCitations(text: string): Citation[] {
  if (!text || typeof text !== "string") return [];
  const re = buildCitationRegex();
  const out: Citation[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const filename = (m[1] ?? "").trim();
    const section = (m[2] ?? "").trim();
    if (!filename || !section) continue;
    const id = `${filename}::${section}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, filename, section });
  }
  return out;
}

/**
 * Incremental streaming parser state.
 *
 * Usage:
 *   const parser = createCitationStreamParser();
 *   for await (const chunk of deltas) {
 *     const newCitations = parser.onDelta(chunk);
 *     for (const c of newCitations) {
 *       // publish FILE_READING activity
 *     }
 *   }
 *
 * Properties:
 * - Buffer capped at ~256 chars — only the trailing suffix that could still
 *   contain an unterminated `[source:...` fragment is kept between calls.
 * - Per-stream state (factory, not singleton) — no cross-request leak.
 * - Global dedup set — same citation is only reported once per stream.
 * - Handles split-tag scenarios: `[sou` + `rce:file.pdf:p1]` → parses on join.
 */
export type CitationStreamParser = {
  onDelta(text: string): Citation[];
  /** Current dedup set size — for tests/debug. */
  seenCount(): number;
};

const MAX_BUFFER = 256;

export function createCitationStreamParser(): CitationStreamParser {
  // Tail buffer: last fragment that MAY contain the start of an unterminated
  // `[source:...` tag. Cleared whenever no `[` sits in the unresolved region.
  let tail = "";
  const seen = new Set<string>();

  const onDelta = (delta: string): Citation[] => {
    if (!delta) return [];
    // Work over tail + delta, but we will only RE-EMIT tags whose match index
    // is inside `delta`'s region (index >= tail.length) OR spans the boundary
    // — i.e. any match whose end > tail.length.
    const joined = tail + delta;

    const re = buildCitationRegex();
    const found: Citation[] = [];
    let m: RegExpExecArray | null;
    let lastMatchEnd = 0;
    while ((m = re.exec(joined)) !== null) {
      lastMatchEnd = m.index + m[0].length;
      // Filter: skip matches fully contained in the old tail (already scanned
      // in a prior call). A match is "new" if its end exceeds tail.length.
      if (lastMatchEnd <= tail.length) continue;
      const filename = (m[1] ?? "").trim();
      const section = (m[2] ?? "").trim();
      if (!filename || !section) continue;
      const id = `${filename}::${section}`;
      if (seen.has(id)) continue;
      seen.add(id);
      found.push({ id, filename, section });
    }

    // Decide new tail. We want to keep enough suffix so that a `[source:...`
    // split across chunk boundaries can be completed next call.
    // Strategy:
    //   - Find the LAST unmatched `[` in `joined` after `lastMatchEnd`.
    //   - If found, keep from that `[` onward (capped at MAX_BUFFER).
    //   - Otherwise, keep just the last MAX_BUFFER chars (cheap safety).
    const scanFrom = Math.max(lastMatchEnd, 0);
    const firstOpen = joined.indexOf("[", scanFrom);
    if (firstOpen !== -1) {
      // Potential partial tag starts here — retain from `[` onward, capped.
      const candidate = joined.slice(firstOpen);
      tail = candidate.length > MAX_BUFFER
        ? candidate.slice(candidate.length - MAX_BUFFER)
        : candidate;
    } else {
      // No unresolved `[` after the last match — nothing to carry over.
      tail = "";
    }

    return found;
  };

  return {
    onDelta,
    seenCount: () => seen.size,
  };
}
