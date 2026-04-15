// src/skills/skill-injector.ts
//
// Phase D.7 — Compact-first skill rendering.
//
// The old renderer was a greedy expander: it appended full skill bodies
// until the budget ran out, then stopped. With 28 skills × 2-3KB each,
// downstream token budgets in PromptBuilder would then TRUNCATE the
// block mid-skill, so the model only saw the first 2-3 skills intact.
//
// New design: render in TWO passes, compact-first.
//   Pass 1 (always emitted): every enabled skill gets a compact entry
//     — title + one-line description + its "when to use" bullets only.
//     ~300-500 chars per skill × 28 = ~10-14KB total.
//   Pass 2 (budget permitting): expand skills back to full body, one
//     at a time from the front of the list, swapping the compact entry
//     with the full entry until the budget would overflow.
//
// Result: the model ALWAYS sees every skill's name, description, and
// trigger criteria. It calls `activate_skill(slug)` to pick one; the
// compact entry is enough to make that decision. When the budget allows,
// the top N skills get their full Process/Anti-pattern sections too.
//
// Hard rules (unchanged):
//   - Never render a disabled skill
//   - Sanitize markdown to strip container-escape tags
//   - Empty enabled set → return "" (never emit empty tags)

import type { Skill } from "./skills-registry";

// Budget tuned so 28 skills compact-rendered fit comfortably + leaves
// headroom for memory_md + reference context inside the 16_000 token
// HARD_REF_TOKEN_CAP in prompt-runtime.
const SKILL_CHAR_BUDGET = 40_000;
const PER_SKILL_FULL_CAP = 3_000;
const PER_SKILL_COMPACT_CAP = 600;

/** Escape characters that break an XML-ish single-line value. */
function xmlAttr(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Sanitize user-authored markdown before dropping it into the prompt.
 * - Strip any closing tag that would escape our container
 * - Normalize whitespace
 * - Hard-truncate to `cap` chars (adds "..." marker)
 */
function sanitizeMarkdown(raw: string, cap: number): string {
  let md = (raw || "").trim();
  if (!md) return "";
  md = md
    .replace(/<\/skills(_policy)?>/gi, "")
    .replace(/<\/skill>/gi, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n");
  if (md.length > cap) {
    md = md.slice(0, cap - 3) + "...";
  }
  return md;
}

/**
 * Extract a compact summary from a full SKILL.md body.
 * Keeps:
 *  - frontmatter block (if present)
 *  - H1 title line (if present)
 *  - Short intro paragraph (first non-heading paragraph after frontmatter/H1)
 *  - The full "When to use" section
 *  - The full "When NOT to use" section
 * Drops: process details, output examples, anti-patterns, etc.
 *
 * Falls back to "first N chars" if the parse can't find structured sections.
 */
function compactMarkdown(raw: string): string {
  const md = (raw || "").replace(/\r\n/g, "\n");
  if (!md.trim()) return "";

  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;

  // 1. Frontmatter (YAML block bounded by ---)
  if (lines[0]?.trim() === "---") {
    out.push(lines[0]);
    i = 1;
    while (i < lines.length && lines[i]?.trim() !== "---") {
      out.push(lines[i]);
      i++;
    }
    if (i < lines.length) {
      out.push(lines[i]); // closing ---
      i++;
    }
    // Consume trailing blank line
    while (i < lines.length && lines[i]?.trim() === "") i++;
  }

  // 2. H1 title + intro paragraph (first block that isn't a heading)
  if (i < lines.length && /^#\s/.test(lines[i])) {
    out.push("", lines[i]);
    i++;
    // Collect the next non-blank block as the intro paragraph (stop at
    // first heading)
    while (i < lines.length && lines[i]?.trim() === "") i++;
    while (i < lines.length && !/^#{1,6}\s/.test(lines[i])) {
      out.push(lines[i]);
      i++;
    }
  }

  // 3. "When to use" + "When NOT to use" sections — keep both.
  while (i < lines.length) {
    const h = lines[i];
    if (!/^##\s+(When to use|When NOT to use)/i.test(h)) {
      i++;
      continue;
    }
    // Push the heading + the section body until the next heading.
    out.push("", h);
    i++;
    while (i < lines.length && !/^##\s/.test(lines[i])) {
      out.push(lines[i]);
      i++;
    }
  }

  let compact = out.join("\n").trim();
  // Hard cap as a safety net.
  if (compact.length > PER_SKILL_COMPACT_CAP) {
    compact = compact.slice(0, PER_SKILL_COMPACT_CAP - 3) + "...";
  }
  // Fallback: if the parse produced nothing (malformed / no sections),
  // use the first PER_SKILL_COMPACT_CAP chars of the sanitized body.
  if (!compact) {
    compact = sanitizeMarkdown(raw, PER_SKILL_COMPACT_CAP);
  }
  return compact;
}

function renderSkillEntry(
  skill: Skill,
  mode: "compact" | "full",
): string {
  const md =
    mode === "full"
      ? sanitizeMarkdown(skill.markdown, PER_SKILL_FULL_CAP)
      : compactMarkdown(skill.markdown);
  if (!md) return "";
  const tools = Array.isArray(skill.allowedTools)
    ? skill.allowedTools.filter((t) => typeof t === "string")
    : [];
  const header =
    `<skill id="${xmlAttr(skill.id)}" slug="${xmlAttr(skill.slug)}" name="${xmlAttr(skill.name)}" version="${xmlAttr(
      skill.version,
    )}" mode="${mode}"` +
    (tools.length > 0 ? ` tools="${xmlAttr(tools.join(","))}"` : "") +
    `>`;
  return `${header}\n${md}\n</skill>`;
}

/**
 * Render the enabled skills as a single `<skills>` XML block with a
 * two-pass compact-first, expand-until-budget strategy. Returns "" if
 * nothing is enabled.
 *
 * Every skill appears in the output. Tokens that can't fit are spent on
 * compact summaries rather than dropped.
 *
 * @param skills   — the full enabled set
 * @param preferredSlugs — ordered list of slugs that should be expanded
 *                        to full body FIRST (Phase 2 retrieval top-k).
 *                        Omitted / empty → preserve input order.
 */
export function renderSkillsBlock(
  skills: Skill[],
  preferredSlugs: string[] = [],
): string {
  const enabled = (skills || []).filter((s) => s && s.enabled);
  if (enabled.length === 0) return "";

  // Reorder so preferredSlugs come first, in the given priority order.
  if (preferredSlugs.length > 0) {
    const priority = new Map<string, number>();
    preferredSlugs.forEach((slug, i) => priority.set(slug, i));
    enabled.sort((a, b) => {
      const ai = priority.has(a.slug) ? priority.get(a.slug)! : 9999;
      const bi = priority.has(b.slug) ? priority.get(b.slug)! : 9999;
      return ai - bi;
    });
  }

  // Pass 1: build every skill as a compact entry. We always render the
  // full list so the model knows every option.
  const compactEntries: string[] = enabled.map((s) => renderSkillEntry(s, "compact"));
  let totalSize = compactEntries.reduce((acc, e) => acc + e.length + 1, 0);

  if (totalSize > SKILL_CHAR_BUDGET) {
    // Even compact overflows. Drop entries from the end until we fit.
    let dropped = 0;
    while (totalSize > SKILL_CHAR_BUDGET && compactEntries.length > 0) {
      const last = compactEntries.pop();
      totalSize -= (last?.length ?? 0) + 1;
      dropped++;
    }
    console.warn(
      `[skill-injector] compact overflow — dropped ${dropped} skills (rendered ${compactEntries.length}/${enabled.length}, total ${totalSize}B)`,
    );
  } else {
    // Pass 2: expand skills from the front until the next expansion
    // would overflow.
    for (let i = 0; i < enabled.length && i < compactEntries.length; i++) {
      const fullEntry = renderSkillEntry(enabled[i], "full");
      if (!fullEntry) continue;
      const delta = fullEntry.length - compactEntries[i].length;
      if (totalSize + delta > SKILL_CHAR_BUDGET) break;
      compactEntries[i] = fullEntry;
      totalSize += delta;
    }
  }

  const expandedCount = compactEntries.filter((e) =>
    e.includes('mode="full"'),
  ).length;
  console.log("[skill-injector] render complete", {
    enabled: enabled.length,
    rendered: compactEntries.length,
    expanded: expandedCount,
    chars: totalSize,
  });

  const policy = `<skills_policy>
READ THIS POLICY CAREFULLY BEFORE ANSWERING ANY QUESTION.

Rule 0 — THE ENTIRE <skills> BLOCK IS LOADED AND AVAILABLE RIGHT NOW.
Every <skill> entry in the block above — whether it has mode="full"
or mode="compact" — is INSTALLED, ENABLED, and CALLABLE for this
turn. You have full access to every one of them. The mode attribute
is ONLY a display detail meaning "how much of the body was shipped
to this prompt" (full = complete body, compact = body summarized to
intro + when-to-use to save tokens). It is NOT an availability flag.
Compact skills are 100% available — you just have the summary of
their internals. If you need a compact skill's full body to execute
it, call activate_skill(slug) and the system will upgrade it.

Rule 0.5 — THE trigger ATTRIBUTE IS ROUTING METADATA, NOT GATING.
trigger="auto" / "slash" / "manual" describes HOW the skill was
originally wired in the catalog, not whether YOU can use it. For
your purposes, assume every skill's trigger is "auto" — you may
activate any of them whenever the user's request matches its
When-to-use section. Never tell the user "this skill is manual-only
so I cannot run it". That is wrong.

Rule 1 — WHEN THE USER ASKS "what skills do you have / 뭐 할 수 있어 /
list skills / capabilities / 스킬 전부 / 전체 기능", you MUST
enumerate every single <skill> entry in the block by name. Do not
answer with 1 or 3 skills. Do not say "only the following is
loaded". List ALL of them. Count the <skill> tags and report that
count. Example format: "Currently enabled (28 skills): 1. memory —
..., 2. code-review — ..., ..., 28. release-notes — ...".

Rule 2 — WHEN THE USER'S REQUEST MATCHES A SKILL'S SCOPE, pick the
ONE whose "When to use" section best fits and follow its Process
section step by step. Match the Output Format when specified. You
may compose at most two skills if they cover orthogonal dimensions
(e.g. "debugging" + "commit-messages"). Honor each skill's "When
NOT to use" and "Anti-patterns" sections.

Rule 3 — NEVER QUOTE SKILL MARKDOWN back to the user verbatim.
Never say "I'm using the X skill" in natural prose. Apply the skill
silently. The activate_skill tool is the ONLY sanctioned way to
signal which skill you are following, and even that is silent
telemetry for the backend, not a user-facing announcement.

Rule 4 — THE "tools" attribute on each <skill> is the allow-list of
tool names that skill may call. Do not call tools outside that list.
If the list is empty, apply the skill's advice without calling
tools.

Rule 5 — IF NO SKILL MATCHES, answer the user directly without
invoking any. Forcing a mismatched skill is worse than using none.

Rule 6 — VIOLATING RULE 0 OR RULE 1 IS A BUG. If you catch yourself
about to write "only one skill is loaded" or "you don't have access
to X" where X is in the block above, stop and re-read Rule 0.
</skills_policy>`;

  return `<skills>\n${compactEntries.join("\n")}\n</skills>\n${policy}`;
}

/**
 * Return the list of tool names allowed across all enabled skills.
 * This is the allow-list the execution engine uses to filter the final
 * `tools[]` array passed to the LLM.
 */
export function collectAllowedToolNames(skills: Skill[]): Set<string> {
  const out = new Set<string>();
  for (const s of skills || []) {
    if (!s || !s.enabled) continue;
    for (const t of s.allowedTools || []) {
      if (typeof t === "string" && t.length > 0) out.add(t);
    }
  }
  return out;
}
