// src/routes/memory-md-helpers.ts
//
// Shared helpers for user memory Markdown manipulation. Extracted from
// memory-md-router so the openai-tool-registry `memory_append` handler
// can reuse the same merge logic without introducing an HTTP hop.
//
// Contract:
//   appendToSection(existing, section, content) → merged
//     - Case-insensitive match on `^## <section>` (Markdown H2)
//     - Dedup: if the section already contains an EXACT bullet line
//       equal to the normalized new bullet, returns `existing` unchanged
//     - Missing section: appends `\n## <section>\n- <content>\n` at EOF
//     - New bullet is inserted at the end of the matching section,
//       walking back over trailing blank lines so the bullet attaches
//       to the last item rather than below a gap

export function appendToSection(
  existing: string,
  section: string,
  content: string,
): string {
  // Harden the incoming bullet — the AI-import path and tool-call path
  // both reach here. Reject embedded newlines and any leading `#` that
  // would re-open a section header on a future read (H3 injection).
  const sanitized = content
    .replace(/\r/g, "")
    .replace(/\n+/g, " ")
    .replace(/^#+\s*/, "")
    .trim();
  if (!sanitized) return existing;

  const bullet = sanitized.startsWith("-") ? sanitized : `- ${sanitized}`;
  const bulletNorm = bullet.trim().toLowerCase();
  const lines = existing.split("\n");
  const sectionRe = new RegExp(
    `^##\\s+${section.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}\\s*$`,
    "i",
  );
  let inSection = false;
  let insertAt = -1;
  let sectionEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (sectionRe.test(line)) {
      inSection = true;
      insertAt = i + 1;
      continue;
    }
    if (inSection) {
      if (/^##\s/.test(line)) {
        sectionEnd = i;
        break;
      }
      if (line.trim().toLowerCase() === bulletNorm) {
        // Exact-line dedup — don't fall into substring false-positives
        // that would silently swallow short bullets like "- pnpm only".
        return existing;
      }
    }
  }

  if (!inSection) {
    // Section missing: append at the end of the document.
    const suffix = existing.endsWith("\n") ? "" : "\n";
    return `${existing}${suffix}\n## ${section}\n${bullet}\n`;
  }

  const tail = sectionEnd >= 0 ? sectionEnd : lines.length;
  // Walk back over trailing blank lines in the section so the new bullet
  // attaches to the last bullet, not below the blank gap.
  let insert = tail;
  while (insert > insertAt && lines[insert - 1].trim() === "") insert--;
  lines.splice(insert, 0, bullet);
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// AI memory export parser — consumes the text block an external assistant
// produces in response to the "export my stored memories" prompt. Returns
// atomic entries that can be fed through appendToSection one at a time.
//
// Expected format (mirrors Claude's import prompt — 7 categories):
//
//   ## 1. Instructions
//   [2026-03-01] [tags: tone] - 반말 사용
//   [unknown] - 비용 민감도 높음
//
//   ## 4. Projects
//   [2026-04-11] [tags: i18n] - YUA settings: ...
//
// Tolerant of: code-fence wrap (anywhere in text, picks LARGEST fence),
// H1 through H4 headers, bold-only headers, numbered or bold names, plain
// "- content" lines without [date], "[YYYY | unknown]" ambiguity.
// Unknown categories are surfaced via `unknownCategories` so the UI can
// warn without silently dropping data.
// ─────────────────────────────────────────────────────────────────────────

export interface ParsedMemoryEntry {
  section: string;          // target MEMORY.md section
  content: string;          // line to append (date-prefixed if known)
  sourceCategory: string;   // original AI header (for debugging)
  date: string | null;      // ISO date or null if "unknown"
  tags: string[];
}

// AI category → MEMORY.md section. Order matters: first match wins.
// Project must come before instruction/rule so "Project Rules" maps to
// projects, not preferences.
const CATEGORY_TO_SECTION: Array<[RegExp, string]> = [
  [/\bproject/i,                                    "Other Projects"],
  [/\b(open\s*loop|next\s*step|todo|follow.?up)/i,  "Open Loops"],
  [/\b(system|workflow|tooling|env|architecture)/i, "Key Rules"],
  [/\bidentit/i,                                    "사용자 프로필"],
  [/\b(career|role|job|profession)/i,               "사용자 프로필"],
  [/\b(instruction|rule)s?\b/i,                     "User Preferences"],
  [/\b(preference|style|taste)s?\b/i,               "User Preferences"],
];

// Accept H1-H4. Optional leading "1." or "1)". Optional **bold**.
const HEADER_RE = /^#{1,4}\s+(?:\d+[.)]\s*)?\*{0,2}([^*#\n]+?)\*{0,2}\s*$/;
// Bold-only header: "**Instructions**" on its own line.
const BOLD_HEADER_RE = /^\*{2}([^*\n]{2,50})\*{2}\s*$/;
// "[date] [tags: a, b] - content" — match first `-|–|—|:` to avoid greedy
// loss on nested bullets with additional separators.
const LINE_RE = /^\[([^\]]+)\]\s*(?:\[tags?:\s*([^\]]+)\])?\s*[-–—:]\s*(.+)$/;

function mapCategory(name: string): string | null {
  const trimmed = name.trim();
  for (const [re, section] of CATEGORY_TO_SECTION) {
    if (re.test(trimmed)) return section;
  }
  return null;
}

// Pull the largest fenced code block out of the text. If the AI wrapped
// only the body in ``` but added prose around it, we want the body.
function extractLargestFence(input: string): string {
  const text = input.trim();
  const fenceRe = /```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```/g;
  let best: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    const body = m[1].trim();
    if (!best || body.length > best.length) best = body;
  }
  return best ?? text;
}

function parseDate(raw: string): string | null {
  // Accept "[YYYY-MM-DD | unknown]" — the prompt shows this as placeholder
  // and some assistants echo it literally. Take the left half.
  const parts = raw.split("|").map((s) => s.trim());
  const first = parts[0] ?? "";
  if (/^unknown$/i.test(first) || !first) return null;
  return first;
}

export function parseAiExport(rawText: string): {
  entries: ParsedMemoryEntry[];
  unknownCategories: string[];
} {
  const text = extractLargestFence(rawText);
  const lines = text.split("\n");
  const entries: ParsedMemoryEntry[] = [];
  const seen = new Set<string>();       // section|content dedup within one paste
  const unknownCategories: string[] = [];
  let currentCategory: string | null = null;
  let currentSection: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    const header = HEADER_RE.exec(line.trim()) || BOLD_HEADER_RE.exec(line.trim());
    if (header) {
      const label = header[1].trim();
      currentCategory = label;
      const mapped = mapCategory(label);
      if (mapped) {
        currentSection = mapped;
      } else {
        currentSection = null;
        if (!unknownCategories.includes(label)) unknownCategories.push(label);
      }
      continue;
    }

    if (!currentSection) continue; // skip content under unmapped headers

    let date: string | null = null;
    let tags: string[] = [];
    let content = "";

    const structured = LINE_RE.exec(line.trim());
    if (structured) {
      const dateRaw = structured[1].trim();
      const tagsRaw = structured[2]?.trim() ?? "";
      content = structured[3].trim();
      date = parseDate(dateRaw);
      tags = tagsRaw
        ? tagsRaw.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
    } else {
      // Fallback: "- content" or bare content
      const plain = line.trim().replace(/^[-*•]\s*/, "").trim();
      if (!plain) continue;
      content = plain;
    }

    if (!content) continue;

    // Defense-in-depth: scrub the bullet before it enters appendToSection,
    // which will do the same work. Belt + suspenders.
    const scrubbed = content
      .replace(/\r/g, "")
      .replace(/\n+/g, " ")
      .replace(/^#+\s*/, "")
      .trim();
    if (!scrubbed) continue;

    let final = scrubbed;
    if (date) final = `[${date}] ${scrubbed}`;
    const bounded = final.slice(0, 2_000);

    const dedupKey = `${currentSection}\u0001${bounded.toLowerCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    entries.push({
      section: currentSection,
      content: bounded,
      sourceCategory: currentCategory ?? "",
      date,
      tags,
    });
  }

  return { entries, unknownCategories };
}
