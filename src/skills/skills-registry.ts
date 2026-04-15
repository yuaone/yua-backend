// src/skills/skills-registry.ts
//
// Phase D.6 — YUA Skills registry (Phase 1).
// Built-in catalog (in-process) + user-authored skills (Postgres).
//
// A "skill" is a Markdown document + metadata that teaches YUA how to
// perform a specific kind of task. At runtime (chat pre-flight) the
// enabled skills are injected into the system prompt as a
// `<skills>` block, scoped per-user. This file is the SSOT for built-in
// skills and the shape contract for user-installed skills.
//
// Persistence (Phase 1): in-memory built-ins + a Postgres-backed row
// per installed/uploaded skill. For now we expose the built-in catalog
// as the directory listing. Phase 2 will add community skills fetched
// from an external registry with caching.
//
// Important contract:
//   - `markdown` is TRUSTED DATA, not instructions to the assistant.
//     When it's injected into a prompt, it sits inside `<skills>` and
//     a policy block above tells the model that these are reference
//     documents describing what the user has authorized.
//   - `allowedTools` is the allow-list of tool names this skill may
//     invoke. Empty/undefined = no tool calls.
//   - User-authored skills must pass content sanitization (strip any
//     closing `</skills>` / nested policy tags) before persistence.

import { pgPool } from "../db/postgres";
import { BUILTIN_SKILLS as FACTORY_BUILTIN_SKILLS } from "./builtin-skills";

export type SkillScope = "official" | "user" | "community";
export type TriggerMode = "auto" | "slash" | "manual";

export interface Skill {
  id: string;
  slug: string;
  name: string;
  description: string;
  scope: SkillScope;
  version: string;
  enabled: boolean;
  markdown: string;
  allowedTools: string[];
  trigger: TriggerMode;
  source: "builtin" | "installed" | "uploaded";
  author: string | null;
  iconUrl: string | null;
  installCount: number;
  license?: string;
}

export interface SkillDirectoryEntry {
  id: string;
  slug: string;
  name: string;
  description: string;
  author: string;
  iconUrl: string | null;
  installCount: number;
  verified: boolean;
  scope: SkillScope;
}

// ─── Built-in official skills ──────────────────────────────────────────
//
// The full catalog lives in ./builtin-skills.ts (factory output). We
// re-export it here so existing call sites (BUILTIN_SKILLS.find etc.)
// keep working without change.
const BUILTIN_SKILLS: Skill[] = FACTORY_BUILTIN_SKILLS;

// ─── DB helpers ─────────────────────────────────────────────────────────

interface UserSkillRow {
  id: number;
  slug: string;
  name: string;
  description: string;
  markdown: string;
  allowed_tools: string[];
  trigger_mode: TriggerMode;
  license: string;
  version: string;
  enabled: boolean;
}

function rowToSkill(row: UserSkillRow): Skill {
  return {
    id: `user.${row.id}`,
    slug: row.slug,
    name: row.name,
    description: row.description,
    scope: "user",
    version: row.version,
    enabled: row.enabled,
    markdown: row.markdown,
    allowedTools: Array.isArray(row.allowed_tools) ? row.allowed_tools : [],
    trigger: row.trigger_mode,
    source: "uploaded",
    author: "You",
    iconUrl: null,
    installCount: 0,
    license: row.license,
  };
}

// ─── Queries ────────────────────────────────────────────────────────────

/**
 * List all skills visible to a user: built-in catalog + their own
 * user_skills rows. Built-in enabled state is overlaid from
 * user_skill_toggles so a user who disables a built-in sees that state
 * across sessions.
 */
export async function listInstalledSkills(userId: number): Promise<Skill[]> {
  // Load toggle overrides for builtins first.
  const overrides = new Map<string, boolean>();
  try {
    const r = await pgPool.query<{ skill_id: string; enabled: boolean }>(
      `SELECT skill_id, enabled FROM user_skill_toggles WHERE user_id = $1`,
      [userId],
    );
    for (const row of r.rows) overrides.set(row.skill_id, row.enabled);
  } catch (err) {
    console.warn("[skills-registry] user_skill_toggles lookup failed", err);
  }

  const out: Skill[] = BUILTIN_SKILLS.map((s) => ({
    ...s,
    enabled: overrides.has(s.id) ? (overrides.get(s.id) as boolean) : s.enabled,
  }));
  try {
    const r = await pgPool.query<UserSkillRow>(
      `SELECT id, slug, name, description, markdown, allowed_tools,
              trigger_mode, license, version, enabled
         FROM user_skills
         WHERE user_id = $1
         ORDER BY created_at ASC`,
      [userId],
    );
    for (const row of r.rows) out.push(rowToSkill(row));
  } catch (err) {
    console.warn("[skills-registry] user_skills lookup failed", err);
  }
  return out;
}

/** Fire-and-forget synchronous variant — returns built-ins only. */
export function listBuiltinSkills(): Skill[] {
  return BUILTIN_SKILLS.map((s) => ({ ...s }));
}

export async function getSkillById(
  userId: number,
  id: string,
): Promise<Skill | null> {
  // Built-in match first (cheap). Overlay any toggle override.
  const builtin = BUILTIN_SKILLS.find((s) => s.id === id);
  if (builtin) {
    let enabled = builtin.enabled;
    try {
      const r = await pgPool.query<{ enabled: boolean }>(
        `SELECT enabled FROM user_skill_toggles WHERE user_id = $1 AND skill_id = $2`,
        [userId, id],
      );
      if (r.rows[0]) enabled = r.rows[0].enabled;
    } catch {}
    return { ...builtin, enabled };
  }
  // User skill — id format "user.<row_id>"
  const m = /^user\.(\d+)$/.exec(id);
  if (!m) return null;
  const rowId = Number(m[1]);
  if (!Number.isFinite(rowId)) return null;
  try {
    const r = await pgPool.query<UserSkillRow>(
      `SELECT id, slug, name, description, markdown, allowed_tools,
              trigger_mode, license, version, enabled
         FROM user_skills
         WHERE id = $1 AND user_id = $2
         LIMIT 1`,
      [rowId, userId],
    );
    const row = r.rows[0];
    return row ? rowToSkill(row) : null;
  } catch (err) {
    console.warn("[skills-registry] getSkillById failed", err);
    return null;
  }
}

export interface CreateSkillInput {
  slug: string;
  name: string;
  description: string;
  markdown: string;
  allowedTools?: string[];
  trigger?: TriggerMode;
  license?: string;
  version?: string;
}

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

export async function createUserSkill(
  userId: number,
  input: CreateSkillInput,
): Promise<Skill | null> {
  const slug = slugify(input.slug || input.name || "untitled");
  if (!slug) return null;
  const name = String(input.name || "").slice(0, 120).trim();
  const description = String(input.description || "").slice(0, 500).trim();
  const markdown = String(input.markdown || "").slice(0, 40_000);
  const allowed =
    Array.isArray(input.allowedTools)
      ? input.allowedTools.filter((t) => typeof t === "string" && t.length > 0)
      : [];
  const trigger: TriggerMode =
    input.trigger === "slash" || input.trigger === "manual"
      ? input.trigger
      : "auto";
  const license = input.license || "YUA User Content";
  const version = input.version || "1.0.0";

  if (!name || !description || !markdown) return null;

  try {
    const r = await pgPool.query<UserSkillRow>(
      `INSERT INTO user_skills (
         user_id, slug, name, description, markdown,
         allowed_tools, trigger_mode, license, version, enabled
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
       ON CONFLICT (user_id, slug) DO UPDATE
         SET name = EXCLUDED.name,
             description = EXCLUDED.description,
             markdown = EXCLUDED.markdown,
             allowed_tools = EXCLUDED.allowed_tools,
             trigger_mode = EXCLUDED.trigger_mode,
             license = EXCLUDED.license,
             version = EXCLUDED.version,
             updated_at = NOW()
       RETURNING id, slug, name, description, markdown, allowed_tools,
                 trigger_mode, license, version, enabled`,
      [userId, slug, name, description, markdown, allowed, trigger, license, version],
    );
    const row = r.rows[0];
    return row ? rowToSkill(row) : null;
  } catch (err) {
    console.warn("[skills-registry] createUserSkill failed", err);
    return null;
  }
}

export async function updateUserSkill(
  userId: number,
  id: string,
  patch: Partial<CreateSkillInput> & { enabled?: boolean },
): Promise<Skill | null> {
  // Built-ins can only toggle `enabled`. Persist to user_skill_toggles
  // so the override survives process restart + lives in DB SSOT.
  const builtin = BUILTIN_SKILLS.find((s) => s.id === id);
  if (builtin) {
    const nextEnabled =
      typeof patch.enabled === "boolean" ? patch.enabled : builtin.enabled;
    if (typeof patch.enabled === "boolean") {
      try {
        await pgPool.query(
          `INSERT INTO user_skill_toggles (user_id, skill_id, enabled)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, skill_id)
               DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
          [userId, id, patch.enabled],
        );
      } catch (err) {
        console.warn("[skills-registry] toggle persist failed", err);
      }
    }
    return { ...builtin, enabled: nextEnabled };
  }
  const m = /^user\.(\d+)$/.exec(id);
  if (!m) return null;
  const rowId = Number(m[1]);
  const sets: string[] = [];
  const vals: any[] = [rowId, userId];
  let i = 3;
  if (typeof patch.name === "string") {
    sets.push(`name = $${i++}`);
    vals.push(patch.name.slice(0, 120));
  }
  if (typeof patch.description === "string") {
    sets.push(`description = $${i++}`);
    vals.push(patch.description.slice(0, 500));
  }
  if (typeof patch.markdown === "string") {
    sets.push(`markdown = $${i++}`);
    vals.push(patch.markdown.slice(0, 40_000));
  }
  if (Array.isArray(patch.allowedTools)) {
    sets.push(`allowed_tools = $${i++}`);
    vals.push(patch.allowedTools.filter((t) => typeof t === "string"));
  }
  if (patch.trigger === "auto" || patch.trigger === "slash" || patch.trigger === "manual") {
    sets.push(`trigger_mode = $${i++}`);
    vals.push(patch.trigger);
  }
  if (typeof patch.enabled === "boolean") {
    sets.push(`enabled = $${i++}`);
    vals.push(patch.enabled);
  }
  if (sets.length === 0) return getSkillById(userId, id);

  try {
    const r = await pgPool.query<UserSkillRow>(
      `UPDATE user_skills SET ${sets.join(", ")}, updated_at = NOW()
         WHERE id = $1 AND user_id = $2
         RETURNING id, slug, name, description, markdown, allowed_tools,
                   trigger_mode, license, version, enabled`,
      vals,
    );
    const row = r.rows[0];
    return row ? rowToSkill(row) : null;
  } catch (err) {
    console.warn("[skills-registry] updateUserSkill failed", err);
    return null;
  }
}

export async function deleteUserSkill(
  userId: number,
  id: string,
): Promise<boolean> {
  const m = /^user\.(\d+)$/.exec(id);
  if (!m) return false;
  const rowId = Number(m[1]);
  try {
    const r = await pgPool.query(
      `DELETE FROM user_skills WHERE id = $1 AND user_id = $2`,
      [rowId, userId],
    );
    return (r.rowCount ?? 0) > 0;
  } catch (err) {
    console.warn("[skills-registry] deleteUserSkill failed", err);
    return false;
  }
}

export function listDirectory(): SkillDirectoryEntry[] {
  // Phase 1: the directory is the built-in set.
  return BUILTIN_SKILLS.map((s) => ({
    id: s.id,
    slug: s.slug,
    name: s.name,
    description: s.description,
    author: s.author ?? "YUA",
    iconUrl: s.iconUrl,
    installCount: s.installCount,
    verified: true,
    scope: s.scope,
  }));
}

export function findDirectoryBySlug(slug: string): Skill | null {
  return BUILTIN_SKILLS.find((s) => s.slug === slug) ?? null;
}
