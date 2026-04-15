// 📂 src/ai/memory/runtime/memory-rule-loader.ts
// 🔥 YUA Memory Rule Loader — PHASE 12-6 / 12-9-3

import type { MemoryRuleSnapshot } from "./memory-rule.types";
import { MemoryRuleSnapshotRepo } from "../repo/memory-rule-snapshot.repo";

const cache = new Map<string, MemoryRuleSnapshot>();

/** 디폴트 룰 — DB에 snapshot 없는 워크스페이스용 */
const DEFAULT_RULES: MemoryRuleSnapshot = {
  auto_commit: { min_confidence: 0.7, min_length: 10 },
  drift: { low: 0.2, medium: 0.5, high: 0.8 },
  merge: { similarity_threshold: 0.85 },
  decay: { base_rate: 0.01, usage_bonus: 0.005 },
  meta: { sample_count: 0, active_count: 0 },
};

export async function loadMemoryRuleSnapshot(
  workspaceId: string
): Promise<MemoryRuleSnapshot> {
  if (cache.has(workspaceId)) {
    return cache.get(workspaceId)!;
  }

  const snapshot =
    await MemoryRuleSnapshotRepo.getLatestApproved(workspaceId);

  const rules = snapshot?.rules ?? DEFAULT_RULES;
  cache.set(workspaceId, rules);
  return rules;
}

/**
 * 🔥 PHASE 12-9-3
 * Rule Apply / Rollback 후 반드시 호출
 */
export function invalidateMemoryRuleCache(
  workspaceId: string
): void {
  cache.delete(workspaceId);
}
