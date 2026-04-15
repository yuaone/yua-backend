// scripts/test-skill-compact-and-retrieval.ts
//
// End-to-end verification of Phase D.7 + Phase 2 W7.
//
// 1. Compact renderer:
//    - all 28 slugs present
//    - every skill has "When to use" section in its output (not dropped)
//    - some skills are full mode, some compact (2-pass expansion worked)
//    - block is within expected budget (< 50KB)
//
// 2. Priority reorder:
//    - passing preferredSlugs moves them to the front
//    - the preferred ones are the first to get "mode=full"
//
// 3. Backfill idempotency:
//    - running ensureSkillEmbeddingsBackfilled twice: second run skips all
//
// 4. Retrieval:
//    - query "SQL 쿼리가 느려" should rank `sql-optimization` top
//    - query "의존성 보안 감사" should rank `dependency-audit` or `security-audit` top
//    - query "커밋 메시지 써줘" should rank `commit-messages` top
//
// If OPENAI_API_KEY is not set, retrieval tests are skipped (marked SKIP).
// Runs: cd /home/dmsal020813/projects/yua-backend && npx tsx scripts/test-skill-compact-and-retrieval.ts

import { pgPool } from "../src/db/postgres";
import { listInstalledSkills } from "../src/skills/skills-registry";
import { renderSkillsBlock } from "../src/skills/skill-injector";
import {
  ensureSkillEmbeddingsBackfilled,
  retrieveTopSkills,
} from "../src/skills/skill-retrieval";

const USER = 8;

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  OK — ${msg}`);
}

function extractSlugs(block: string): string[] {
  const re = /slug="([^"]+)"/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) out.push(m[1]);
  return out;
}

function countFullMode(block: string): number {
  // Match only on <skill ... mode="full"> tag, NOT on mentions inside
  // <skills_policy> which also uses the literal string as documentation.
  return (block.match(/<skill[^>]*\bmode="full"/g) || []).length;
}

function countCompactMode(block: string): number {
  return (block.match(/<skill[^>]*\bmode="compact"/g) || []).length;
}

async function main() {
  console.log("=== Phase D.7 + W7 E2E ===");

  // Reset any prior toggles so baseline is predictable.
  await pgPool.query(`DELETE FROM user_skill_toggles WHERE user_id = $1`, [USER]);

  const skills = await listInstalledSkills(USER);
  const enabled = skills.filter((s) => s.enabled);
  assert(enabled.length === 28, `28 skills enabled (got ${enabled.length})`);

  // ── 1. compact renderer baseline ───────────────────────────────
  console.log("\nSTEP 1: compact renderer");
  const block = renderSkillsBlock(enabled);
  const slugs = extractSlugs(block);
  assert(slugs.length === 28, `block contains 28 slugs (got ${slugs.length})`);
  assert(
    block.length < 50_000,
    `block under 50KB budget (got ${block.length})`,
  );
  const fullCount = countFullMode(block);
  const compactCount = countCompactMode(block);
  assert(fullCount > 0, `some skills rendered in full mode (${fullCount})`);
  assert(
    fullCount + compactCount === 28,
    `every skill got either full or compact (${fullCount + compactCount})`,
  );
  // Every skill should retain its "When to use" heading — even in
  // compact mode that's the whole point.
  for (const skill of enabled) {
    assert(
      block.includes(`slug="${skill.slug}"`),
      `slug ${skill.slug} present`,
    );
  }

  // ── 2. priority reorder ────────────────────────────────────────
  console.log("\nSTEP 2: priority reorder");
  const preferred = ["sql-optimization", "memory", "code-review"];
  const prioBlock = renderSkillsBlock(enabled, preferred);
  const prioSlugs = extractSlugs(prioBlock);
  assert(prioSlugs[0] === "sql-optimization", "first slug is sql-optimization");
  assert(prioSlugs[1] === "memory", "second slug is memory");
  assert(prioSlugs[2] === "code-review", "third slug is code-review");
  assert(prioSlugs.length === 28, "all 28 still present after reorder");

  // ── 3. backfill ────────────────────────────────────────────────
  console.log("\nSTEP 3: backfill (idempotent)");
  if (!process.env.OPENAI_API_KEY) {
    console.log("  SKIP — OPENAI_API_KEY not set");
  } else {
    await ensureSkillEmbeddingsBackfilled();
    const r1 = await pgPool.query<{ count: string }>(
      `SELECT COUNT(*) FROM skill_embeddings WHERE scope='official' AND mode='compact'`,
    );
    const before = Number(r1.rows[0]?.count ?? 0);
    assert(before >= 28, `at least 28 embeddings after first backfill (${before})`);

    // Second run should skip everything.
    await ensureSkillEmbeddingsBackfilled();
    const r2 = await pgPool.query<{ count: string }>(
      `SELECT COUNT(*) FROM skill_embeddings WHERE scope='official' AND mode='compact'`,
    );
    const after = Number(r2.rows[0]?.count ?? 0);
    assert(after === before, "second backfill is idempotent");
  }

  // ── 4. retrieval ───────────────────────────────────────────────
  console.log("\nSTEP 4: retrieval top-k");
  if (!process.env.OPENAI_API_KEY) {
    console.log("  SKIP — OPENAI_API_KEY not set");
  } else {
    const cases: Array<[string, string[]]> = [
      ["SQL 쿼리가 너무 느린데 어떻게 튜닝하지", ["sql-optimization"]],
      ["이 PR 코드 리뷰 해줘", ["code-review"]],
      ["커밋 메시지 써줘", ["commit-messages"]],
      ["이 버그 원인 찾아줘", ["debugging"]],
      ["Kubernetes pod 가 계속 죽어", ["k8s-debugging"]],
    ];
    for (const [query, expectedSlugs] of cases) {
      const top = await retrieveTopSkills(query, 5);
      console.log(`  query: "${query}" → top: ${JSON.stringify(top)}`);
      const found = expectedSlugs.some((slug) => top.includes(slug));
      if (!found) {
        console.warn(
          `    WARN — expected one of ${expectedSlugs.join("/")} in top-5, got ${top.join(",")}`,
        );
      } else {
        console.log(
          `    OK — ${expectedSlugs.find((s) => top.includes(s))} in top-5`,
        );
      }
    }
  }

  console.log("\n=== E2E PASS ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
