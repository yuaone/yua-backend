// src/ai/mop/mop-gate.ts
// MoP Gate: Routes user messages to relevant Expert Prompts.
// 3-tier cascade: Keyword → Embedding → Fallback (CORE only)
//
// This is the "MoE gate" for prompts. It determines which
// tool experts to activate, reducing 87 tools → 5-15 tools.

import { MOP_EXPERTS, type MopExpert } from "./mop-experts";

export interface MopGateResult {
  activatedExperts: MopExpert[];
  method: "keyword" | "embedding" | "fallback" | "cache";
  totalToolProviders: string[];
  totalNativeTools: string[];
}

// Redis cache for per-user expert affinity (imported lazily)
let redisGet: ((key: string) => Promise<string | null>) | null = null;
let redisSet: ((key: string, val: string, mode: "EX" | "PX", ttl: number) => Promise<unknown>) | null = null;

export function setRedisClient(get: typeof redisGet, set: typeof redisSet) {
  redisGet = get;
  redisSet = set;
}

/**
 * Tier 1: Keyword matching (0ms, 100% free)
 * Scans user message for known patterns → activates matching experts.
 */
function keywordGate(message: string): MopExpert[] {
  const matched: MopExpert[] = [];

  for (const expert of MOP_EXPERTS) {
    if (expert.alwaysActive) continue; // CORE is added separately
    for (const pattern of expert.keywordPatterns) {
      if (pattern.test(message)) {
        matched.push(expert);
        break; // one match per expert is enough
      }
    }
  }

  return matched;
}

/**
 * Main gate function.
 * Returns which experts to activate for this message.
 */
export async function routeMessage(
  message: string,
  userId?: number,
): Promise<MopGateResult> {
  const core = MOP_EXPERTS.find(e => e.alwaysActive)!;

  // --- L1 Cache: per-user recent experts ---
  // NOTE: L1 cache disabled — was causing expert accumulation bug
  // (cached experts merged with new keyword matches → providers grew unbounded)
  // Keyword gate is fast enough (~0ms) to run every time.

  // --- Tier 1: Keyword Gate ---
  const keywordMatches = keywordGate(message);

  if (keywordMatches.length > 0) {
    return buildResult([core, ...keywordMatches], "keyword");
  }

  // --- Tier 2: Embedding Gate (TODO: implement with /v1/embed) ---
  // For now, skip to fallback. Will be implemented in Phase 3.

  // --- Tier 3: Fallback — CORE only ---
  return buildResult([core], "fallback");
}

/**
 * Cache activated experts for a user (non-blocking)
 */
function cacheExperts(userId: number | undefined, experts: MopExpert[]) {
  if (!userId || !redisSet) return;
  const ids = experts.map(e => e.id);
  redisSet(`mop:user:${userId}:experts`, JSON.stringify(ids), "EX", 300)
    .catch(() => {});
}

/**
 * Deduplicate experts by ID
 */
function dedup(experts: MopExpert[]): MopExpert[] {
  const seen = new Set<string>();
  return experts.filter(e => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
}

/**
 * Build the final gate result with flattened tool lists
 */
function buildResult(experts: MopExpert[], method: MopGateResult["method"]): MopGateResult {
  const providers: string[] = [];
  const nativeTools: string[] = [];

  for (const expert of experts) {
    for (const p of expert.toolProviders) {
      if (!providers.includes(p)) providers.push(p);
    }
    if (expert.nativeTools) {
      for (const t of expert.nativeTools) {
        if (!nativeTools.includes(t)) nativeTools.push(t);
      }
    }
  }

  return {
    activatedExperts: experts,
    method,
    totalToolProviders: providers,
    totalNativeTools: nativeTools,
  };
}

/**
 * Filter MCP tools based on gate result.
 * Only includes tools from activated expert providers.
 */
export function filterToolsByGate<T extends { name: string; _provider?: string }>(
  allTools: T[],
  gateResult: MopGateResult,
): T[] {
  const allowedProviders = new Set(gateResult.totalToolProviders);

  // If no providers specified (CORE only), allow all native but no MCP
  if (allowedProviders.size === 0) {
    return []; // No MCP tools, only native tools are injected separately
  }

  return allTools.filter(t => {
    const provider = t._provider ?? t.name.split(".")[0];
    return allowedProviders.has(provider);
  });
}
