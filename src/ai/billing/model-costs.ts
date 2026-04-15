// 🔒 Model Cost SSOT — OpenAI Responses / chat completions 가격표 단일 출처
//
// 참고:
//   - https://openai.com/api/pricing/
//   - per Mtok (1,000,000 tokens) USD 단가
//   - cached input tokens는 일반 input의 25% 가격 (OpenAI policy)
//
// 사용처:
//   - execution-engine stream-end 에서 usage 수신 후 `calculateUSDCost()` 로
//     실제 달러 비용 산출 → workspace_usage_log 에 기록 + Redis 카운터 증분.
//   - admin / usage panel 이 이 비용을 월 단위로 집계해서 유저에게 보여준다.
//
// 확장:
//   - 새 모델 런칭 시 여기 한 줄만 추가하면 downstream 자동 반영.
//   - 모르는 모델이 들어오면 DEFAULT_MODEL_COSTS 로 fallback.

export interface ModelCosts {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /**
   * USD per 1M cached input tokens. If omitted, we assume 25% of `input`
   * (OpenAI standard cache discount).
   */
  cachedInput?: number;
}

/**
 * OpenAI model catalog — per-model USD pricing (per 1M tokens).
 * Keep this sorted by family and make sure every model used in
 * pick-model.ts / openai-runtime.ts has an entry.
 */
export const OPENAI_MODEL_COSTS: Record<string, ModelCosts> = {
  // ── GPT-5.4 family ──────────────────────────────────────────────
  "gpt-5.4": { input: 2.5, output: 15.0, cachedInput: 0.625 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cachedInput: 0.1875 },
  // ── GPT-5 family (legacy) ──────────────────────────────────────
  "gpt-5": { input: 1.25, output: 10.0, cachedInput: 0.125 },
  "gpt-5-mini": { input: 0.25, output: 2.0, cachedInput: 0.025 },
  "gpt-5-nano": { input: 0.05, output: 0.4, cachedInput: 0.005 },
  "gpt-5-thinking": { input: 1.25, output: 10.0, cachedInput: 0.125 },
  "gpt-5.2-thinking": { input: 1.25, output: 10.0, cachedInput: 0.125 },
  "gpt-5-4-thinking": { input: 1.25, output: 10.0, cachedInput: 0.125 },

  // ── GPT-4.1 family ──────────────────────────────────────────────
  "gpt-4.1": { input: 2.0, output: 8.0, cachedInput: 0.5 },
  "gpt-4.1-mini": { input: 0.15, output: 0.6, cachedInput: 0.0375 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4, cachedInput: 0.025 },
  "gpt-4.1-preview": { input: 2.0, output: 8.0, cachedInput: 0.5 },

  // ── GPT-4o family (legacy) ─────────────────────────────────────
  "gpt-4o": { input: 2.5, output: 10.0, cachedInput: 1.25 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cachedInput: 0.075 },

  // ── o-series reasoning (reference) ──────────────────────────────
  o1: { input: 15.0, output: 60.0, cachedInput: 7.5 },
  "o1-mini": { input: 3.0, output: 12.0, cachedInput: 1.5 },
  "o3-mini": { input: 1.1, output: 4.4, cachedInput: 0.55 },

  // ── Embedding (for completeness; not used in chat cost) ─────────
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "text-embedding-3-large": { input: 0.13, output: 0 },
};

/**
 * Fallback for unknown models (conservative — assume Sonnet-tier). Logged
 * separately in `recordUsage()` so we can surface "unknown model" in admin.
 */
export const DEFAULT_MODEL_COSTS: ModelCosts = {
  input: 3.0,
  output: 15.0,
  cachedInput: 0.75,
};

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  /** OpenAI Responses API: cache read tokens. */
  cached_input_tokens?: number;
  /** Reasoning tokens (billed as output). */
  reasoning_tokens?: number;
}

/**
 * Calculate USD cost for a single stream response.
 * Returns 0 if any input is malformed — never throws, never NaN.
 */
export function calculateUSDCost(
  model: string,
  usage: TokenUsage
): { costUsd: number; costs: ModelCosts; resolved: string } {
  const costs = OPENAI_MODEL_COSTS[model] ?? DEFAULT_MODEL_COSTS;
  const resolved = OPENAI_MODEL_COSTS[model] ? model : "__unknown__";

  const inputTokens = Number.isFinite(usage.input_tokens)
    ? Math.max(0, usage.input_tokens)
    : 0;
  const outputTokens = Number.isFinite(usage.output_tokens)
    ? Math.max(0, usage.output_tokens)
    : 0;
  const cachedTokens = Number.isFinite(usage.cached_input_tokens ?? 0)
    ? Math.max(0, usage.cached_input_tokens ?? 0)
    : 0;
  const reasoningTokens = Number.isFinite(usage.reasoning_tokens ?? 0)
    ? Math.max(0, usage.reasoning_tokens ?? 0)
    : 0;

  // Subtract cached tokens from input (they're billed at cache rate separately)
  const billableInput = Math.max(0, inputTokens - cachedTokens);
  const cachedRate = costs.cachedInput ?? costs.input * 0.25;

  const inputCost = (billableInput / 1_000_000) * costs.input;
  const cacheCost = (cachedTokens / 1_000_000) * cachedRate;
  // Reasoning tokens are billed as output tokens (Responses API convention)
  const outputCost =
    ((outputTokens + reasoningTokens) / 1_000_000) * costs.output;

  const costUsd = inputCost + cacheCost + outputCost;
  return {
    costUsd: Number.isFinite(costUsd) ? costUsd : 0,
    costs,
    resolved,
  };
}

/**
 * Format a USD amount for display. Always 4 decimal places for cost
 * transparency (we're dealing with sub-cent amounts).
 */
export function formatUSD(cost: number): string {
  if (!Number.isFinite(cost)) return "$0.0000";
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(4)}`;
}
