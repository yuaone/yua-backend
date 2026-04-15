// 📂 yua-backend/src/ai/billing/usage-recorder.ts
//
// Post-stream usage recorder. Called AFTER a chat stream ends successfully,
// fire-and-forget. Writes 5 sinks:
//   1. calculateUSDCost() — resolve dollar amount from token usage
//   2. workspace_usage_log INSERT — durable per-message audit log
//   3. Session counter HINCRBY — gate input for next message
//   4. Monthly spend INCRBY (Redis, 45-day TTL) — infra cost guard
//   5. user_usage_weekly PG upsert — weekly fairness bucket
//
// Each sink is wrapped in its own try/catch; partial failures are allowed
// (log-and-continue) so one broken sink never affects the others or the
// chat stream itself. This function must NEVER throw.
//
// Owner: Agent A (Batch 3 — Usage System Backend)

import { pgPool } from "../../db/postgres";
import { redisPub } from "../../db/redis";
import { calculateUSDCost, type TokenUsage } from "./model-costs";
import { incrementSession } from "./usage-session-tracker";
import { incrementWeekly } from "./usage-weekly-tracker";
import { applyCreditMutation } from "../../billing/lemonsqueezy/credit-grant";
import type { PlanId } from "yua-shared/plan/plan-pricing";

export interface UsageRecordInput {
  userId: number;
  /** UUID string — workspaces.id is uuid, not bigint. */
  workspaceId: string | null;
  threadId: number | null;
  messageId: number | null;
  model: string;
  usage: TokenUsage;
  planTier: PlanId;
  computeTier: "FAST" | "NORMAL" | "DEEP";
  /**
   * If the gate result was `credits_bypass`, the stream ran on credit debit
   * instead of against the session/weekly counters. In that case we:
   *   1. INSERT workspace_usage_log as usual (audit)
   *   2. SKIP session/weekly increments (user has already hit the cap)
   *   3. DEBIT user_credit_ledger instead
   */
  creditsBypass?: boolean;
}

function currentMonthKey(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

const SPEND_TTL_SECONDS = 45 * 24 * 60 * 60; // 45 days

/**
 * Record a single completed chat turn's usage across all 5 sinks.
 * Fire-and-forget: returns `{ costUsd, resolved }` for caller logging,
 * but never rejects — any internal failure is swallowed + console.warn'd.
 */
export async function recordUsage(
  input: UsageRecordInput
): Promise<{ costUsd: number; resolved: string }> {
  // ── Step 1: USD cost calculation ────────────────────────────────────
  let costUsd = 0;
  let resolved = "__unknown__";
  try {
    const r = calculateUSDCost(input.model, input.usage);
    costUsd = r.costUsd;
    resolved = r.resolved;
  } catch (err) {
    console.warn("[usage-recorder] calculateUSDCost failed", err);
  }

  const costCents = Math.max(0, Math.round(costUsd * 100));

  // ── Step 2: workspace_usage_log INSERT ──────────────────────────────
  //
  // `workspace_usage_log.workspace_id` has a NOT NULL constraint. If the
  // caller omitted a workspaceId (e.g. non-stream entry that lost the
  // workspace context somewhere upstream), we used to INSERT with null
  // and PG rejected the row with `23502 ExecConstraints` spamming pm2
  // error logs every message. Skip the insert with a warn instead —
  // the audit row is lost but the chat flow doesn't stumble.
  if (!input.workspaceId) {
    console.warn("[usage-recorder] skipping workspace_usage_log insert — no workspaceId", {
      userId: input.userId,
      threadId: input.threadId,
      model: input.model,
    });
  } else {
    try {
      await pgPool.query(
        `INSERT INTO workspace_usage_log (
           workspace_id, user_id, thread_id, message_id,
           model, resolved,
           input_tokens, output_tokens, cached_tokens, reasoning_tokens,
           cost_usd, plan_tier, compute_tier, created_at
         ) VALUES (
           $1, $2, $3, $4,
           $5, $6,
           $7, $8, $9, $10,
           $11, $12, $13, NOW()
         )`,
        [
          input.workspaceId,
          input.userId,
          input.threadId,
          input.messageId,
          input.model,
          resolved,
          Math.max(0, Math.round(input.usage?.input_tokens ?? 0)),
          Math.max(0, Math.round(input.usage?.output_tokens ?? 0)),
          Math.max(0, Math.round(input.usage?.cached_input_tokens ?? 0)),
          Math.max(0, Math.round(input.usage?.reasoning_tokens ?? 0)),
          costUsd,
          input.planTier,
          input.computeTier,
        ]
      );
    } catch (err) {
      console.warn("[usage-recorder] workspace_usage_log insert failed", err);
    }
  }

  if (input.creditsBypass) {
    // ── Credits-bypass path: debit the ledger, skip session/weekly counters
    // ── (user already hit those caps — we're running on purchased credits).
    try {
      await applyCreditMutation({
        userId: input.userId,
        type: "consume",
        amountCents: -costCents,  // negative = debit
        refType: "usage_log_id",
        refId: input.messageId != null ? String(input.messageId) : null,
        note: `consume ${input.model} ${input.computeTier}`,
      });
    } catch (err) {
      console.warn("[usage-recorder] credit consume failed", err);
    }
    return { costUsd, resolved };
  }

  // ── Step 3: Session counter (Redis HINCRBY — preserves TTL) ─────────
  // Threads token usage alongside the dollar cost so /api/usage/detailed
  // can display "이번 세션: 125K tokens" breakdowns without a PG round trip.
  try {
    await incrementSession(input.userId, {
      costUsdCents: costCents,
      inputTokens: Number(input.usage?.input_tokens ?? 0),
      // reasoning tokens are billed as output — lump them together
      outputTokens:
        Number(input.usage?.output_tokens ?? 0) +
        Number(input.usage?.reasoning_tokens ?? 0),
      cachedTokens: Number(input.usage?.cached_input_tokens ?? 0),
    });
  } catch (err) {
    console.warn("[usage-recorder] incrementSession failed", err);
  }

  // ── Step 4: Monthly spend counter (Redis INCRBY, 45-day TTL) ────────
  try {
    const monthKey = currentMonthKey();
    const spendKey = `usage:spend:user:${input.userId}:${monthKey}`;
    const pipeline = redisPub.multi();
    pipeline.incrby(spendKey, costCents);
    pipeline.expire(spendKey, SPEND_TTL_SECONDS);
    await pipeline.exec();
  } catch (err) {
    console.warn("[usage-recorder] monthly spend incrby failed", err);
  }

  // ── Step 5: Weekly PG upsert ────────────────────────────────────────
  try {
    await incrementWeekly(input.userId, costUsd);
  } catch (err) {
    console.warn("[usage-recorder] incrementWeekly failed", err);
  }

  return { costUsd, resolved };
}
