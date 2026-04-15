// 📂 yua-backend/src/ai/billing/usage-session-tracker.ts
//
// Rolling session window tracker (Redis-backed).
//
// Session window caps burst usage per tier. The window starts on the first
// message after the previous window expires and rolls for `windowHours` from
// `PLAN_CONFIGS[planTier].session`. Storage lives in Redis so gate checks are
// O(1) hash reads. All writes preserve TTL.
//
// Owner: Agent A (Batch 3 — Usage System Backend)

import { redisPub } from "../../db/redis";
import { PLAN_CONFIGS, type PlanId } from "yua-shared/plan/plan-pricing";

export interface SessionState {
  /** Unix ms at which this window opened. */
  windowStart: number;
  /** Messages spent in this window. */
  msgCount: number;
  /** Cost spent in this window, in USD cents (integer). */
  costUsdCents: number;
  /** Total input tokens consumed in this window (pre-prompt, system, history). */
  inputTokens: number;
  /** Total output tokens (including reasoning tokens, billed as output). */
  outputTokens: number;
  /** Total cached input tokens (OpenAI discounted). */
  cachedTokens: number;
  /** Plan tier active when this window opened — tier change invalidates. */
  planTierAtStart: PlanId;
}

function keyFor(userId: number): string {
  return `usage:session:user:${userId}`;
}

function ttlSecondsFor(planTier: PlanId): number {
  const hours = PLAN_CONFIGS[planTier]?.session?.windowHours ?? 24;
  return Math.max(1, Math.round(hours * 3600));
}

function freshState(planTier: PlanId): SessionState {
  return {
    windowStart: Date.now(),
    msgCount: 0,
    costUsdCents: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    planTierAtStart: planTier,
  };
}

async function writeFresh(
  userId: number,
  state: SessionState,
  planTier: PlanId
): Promise<void> {
  const key = keyFor(userId);
  // Use a multi to set the full hash atomically then set TTL.
  await redisPub
    .multi()
    .del(key)
    .hset(key, {
      windowStart: String(state.windowStart),
      msgCount: String(state.msgCount),
      costUsdCents: String(state.costUsdCents),
      inputTokens: String(state.inputTokens),
      outputTokens: String(state.outputTokens),
      cachedTokens: String(state.cachedTokens),
      planTierAtStart: state.planTierAtStart,
    })
    .expire(key, ttlSecondsFor(planTier))
    .exec();
}

/**
 * Get the current session state, initializing a fresh one if missing,
 * expired, or if the user's plan tier has changed since the window opened.
 */
export async function getOrInitSession(
  userId: number,
  planTier: PlanId
): Promise<SessionState> {
  const key = keyFor(userId);
  let raw: Record<string, string> = {};
  try {
    raw = (await redisPub.hgetall(key)) || {};
  } catch (err) {
    console.warn("[usage-session-tracker] hgetall failed", err);
    raw = {};
  }

  const hasAny = raw && Object.keys(raw).length > 0;
  const windowStart = Number(raw.windowStart);
  const windowMs = ttlSecondsFor(planTier) * 1000;
  const expired =
    hasAny &&
    (!Number.isFinite(windowStart) || Date.now() - windowStart > windowMs);
  const tierMismatch =
    hasAny && raw.planTierAtStart && raw.planTierAtStart !== planTier;

  if (!hasAny || expired || tierMismatch) {
    const fresh = freshState(planTier);
    try {
      await writeFresh(userId, fresh, planTier);
    } catch (err) {
      console.warn("[usage-session-tracker] writeFresh failed", err);
    }
    return fresh;
  }

  return {
    windowStart: Number(raw.windowStart) || Date.now(),
    msgCount: Number(raw.msgCount) || 0,
    costUsdCents: Number(raw.costUsdCents) || 0,
    inputTokens: Number(raw.inputTokens) || 0,
    outputTokens: Number(raw.outputTokens) || 0,
    cachedTokens: Number(raw.cachedTokens) || 0,
    planTierAtStart: (raw.planTierAtStart as PlanId) || planTier,
  };
}

export interface IncrementInput {
  costUsdCents: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

/**
 * Atomically increment the session counters. Preserves existing TTL.
 * Returns the post-increment state. Does NOT initialize — assumes caller
 * already invoked `getOrInitSession` earlier in the request.
 */
export async function incrementSession(
  userId: number,
  costUsdCentsOrInput: number | IncrementInput,
  /** @deprecated — older 2-arg callers pass only costUsdCents */
  _unused?: never,
): Promise<SessionState> {
  const input: IncrementInput =
    typeof costUsdCentsOrInput === "number"
      ? { costUsdCents: costUsdCentsOrInput }
      : costUsdCentsOrInput;
  const key = keyFor(userId);
  const cents = Math.max(0, Math.round(input.costUsdCents));
  const inT = Math.max(0, Math.round(input.inputTokens ?? 0));
  const outT = Math.max(0, Math.round(input.outputTokens ?? 0));
  const cachedT = Math.max(0, Math.round(input.cachedTokens ?? 0));
  try {
    const pipeline = redisPub.multi();
    pipeline.hincrby(key, "msgCount", 1);
    pipeline.hincrby(key, "costUsdCents", cents);
    if (inT > 0) pipeline.hincrby(key, "inputTokens", inT);
    if (outT > 0) pipeline.hincrby(key, "outputTokens", outT);
    if (cachedT > 0) pipeline.hincrby(key, "cachedTokens", cachedT);
    pipeline.hgetall(key);
    const results = await pipeline.exec();
    // Last reply is the hgetall; its index depends on how many conditional
    // hincrby ran. Just fetch again — cheap and correct.
    const raw = (await redisPub.hgetall(key)) || {};
    return {
      windowStart: Number(raw.windowStart) || Date.now(),
      msgCount: Number(raw.msgCount) || 0,
      costUsdCents: Number(raw.costUsdCents) || 0,
      inputTokens: Number(raw.inputTokens) || 0,
      outputTokens: Number(raw.outputTokens) || 0,
      cachedTokens: Number(raw.cachedTokens) || 0,
      planTierAtStart:
        ((raw.planTierAtStart as PlanId) || "free") as PlanId,
    };
  } catch (err) {
    console.warn("[usage-session-tracker] incrementSession failed", err);
    return {
      windowStart: Date.now(),
      msgCount: 0,
      costUsdCents: cents,
      inputTokens: inT,
      outputTokens: outT,
      cachedTokens: cachedT,
      planTierAtStart: "free",
    };
  }
}

/**
 * Force-reset the session window for a user (e.g. on plan upgrade webhook).
 */
export async function resetSession(
  userId: number,
  planTier: PlanId
): Promise<void> {
  try {
    await writeFresh(userId, freshState(planTier), planTier);
  } catch (err) {
    console.warn("[usage-session-tracker] resetSession failed", err);
  }
}
