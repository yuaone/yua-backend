import type { PathType } from "../../routes/path-router";
import type { ChatMode } from "../chat/types/chat-mode";
import type { ThinkingProfile, DeepVariant } from "yua-shared";
export type ComputeTier = "FAST" | "NORMAL" | "DEEP";

/**
 * Plan tier → max output tokens matrix.
 *
 * DEEP (reasoning) needs much more headroom than NORMAL because users request
 * "완성형 코드 달라" style long outputs. FREE stays conservative for cost.
 * ENTERPRISE/MAX get enough to emit full production-grade code files.
 */
/**
 * 🔥 Output token budget matrix — ChatGPT/Claude 벤치마크 기반 리밸런싱.
 * NORMAL은 단일 응답 완결형 (~1,000-2,000자 한국어) 기준.
 * DEEP은 장문 분석/코드 생성 허용.
 * 비용: GPT-5.4 output $15/1M → NORMAL 2,048 tokens = $0.031/msg.
 */
const PLAN_TIER_TOKEN_BUDGET: Record<
  "free" | "pro" | "business" | "enterprise" | "max",
  { fast: number; normal: number; deep: number }
> = {
  free:       { fast: 400,   normal: 1_024,  deep: 2_048 },
  pro:        { fast: 512,   normal: 2_048,  deep: 4_096 },
  business:   { fast: 512,   normal: 2_048,  deep: 8_192 },
  enterprise: { fast: 768,   normal: 3_072,  deep: 16_384 },
  max:        { fast: 1_024, normal: 4_096,  deep: 32_768 },
};

export type PlanTierForCompute =
  | "free"
  | "pro"
  | "business"
  | "enterprise"
  | "max";

function resolveMaxOutputTokens(
  tier: ComputeTier,
  planTier: PlanTierForCompute
): number {
  const budget =
    PLAN_TIER_TOKEN_BUDGET[planTier] ?? PLAN_TIER_TOKEN_BUDGET.free;
  switch (tier) {
    case "FAST":
      return budget.fast;
    case "DEEP":
      return budget.deep;
    case "NORMAL":
    default:
      return budget.normal;
  }
}

export interface ComputePolicy {
  tier: ComputeTier;
  /** STREAM continuation segment upper bound (still gated by allowContinuation) */
  maxSegments: number;
  /** Stream flush cadence (UX + server load) */
  flushIntervalMs: number;
  verifierBudget?: number;
 // 🔍 SEARCH
  allowSearch?: boolean;
  maxSearchRetriesPerSegment?: number;
  deepVariant?: DeepVariant;
  reasoningFlushIntervalMs?: number;
  /** Idle cutoff for stream session */
  idleMs: number;
  /**
   * Plan-tier aware max output token budget. Downstream OpenAI runtime uses
   * this instead of a hardcoded per-mode ceiling so enterprise users can emit
   * full code files without getting truncated mid-output.
   */
  maxOutputTokens: number;
  /** Plan tier (free/pro/business/enterprise/max) — propagated for logging */
  planTier: PlanTierForCompute;
}

export function decideComputePolicy(args: {
  path: PathType;
  mode: ChatMode;
  thinkingProfile: ThinkingProfile;
  hasImage: boolean;
  verifierVerdict?: "PASS" | "WEAK" | "FAIL";
  failureRisk?: "LOW" | "MEDIUM" | "HIGH";
  deepVariant?: DeepVariant;
  /** Plan tier for token budget resolution (defaults to "free"). */
  planTier?: PlanTierForCompute;
}): ComputePolicy {
  const {
    thinkingProfile,
    hasImage,
    verifierVerdict,
    failureRisk,
    deepVariant,
  } = args;
  const planTier: PlanTierForCompute = args.planTier ?? "free";

  // 🔒 SSOT: 이미지 입력은 기본 NORMAL (FAST는 명시 요청만)
  if (hasImage) {
    if (thinkingProfile === "FAST") {
      return {
        tier: "FAST",
        maxSegments: 1,
        flushIntervalMs: 25,
        idleMs: 1200,
        maxOutputTokens: resolveMaxOutputTokens("FAST", planTier),
        planTier,
      };
    }
    return {
      tier: "NORMAL",
      maxSegments: 4,
      flushIntervalMs: 80,
      idleMs: 2000,
      maxOutputTokens: resolveMaxOutputTokens("NORMAL", planTier),
      planTier,
    };
  }

  const requestedDeep = thinkingProfile === "DEEP";
  const forceDeepCompute =
    verifierVerdict === "FAIL" || failureRisk === "HIGH";
  let useDeepCompute = requestedDeep || forceDeepCompute;

  if (
    thinkingProfile !== "DEEP" &&
    verifierVerdict === "PASS" &&
    failureRisk === "LOW"
  ) {
    useDeepCompute = false;
  }

  const tier: ComputeTier = useDeepCompute
    ? "DEEP"
    : thinkingProfile === "FAST"
      ? "FAST"
      : "NORMAL";

  const maxOutputTokens = resolveMaxOutputTokens(tier, planTier);

  switch (tier) {
    case "DEEP":
      if (deepVariant === "EXPANDED") {
        return {
          tier: "DEEP",
          maxSegments: 7,
          flushIntervalMs: 240,
          idleMs: 4500,
          deepVariant: "EXPANDED",
          reasoningFlushIntervalMs: 420,
          verifierBudget: 5,
          allowSearch: true,
          maxSearchRetriesPerSegment: 3,
          maxOutputTokens,
          planTier,
        };
      }

      return {
        tier: "DEEP",
        maxSegments: 5,
        flushIntervalMs: 180,
        idleMs: 3500,
        deepVariant: "STANDARD",
        reasoningFlushIntervalMs: 280,
        verifierBudget: 3,
        maxOutputTokens,
        planTier,
      };
    case "FAST":
      return {
        tier: "FAST",
        maxSegments: 1,
        flushIntervalMs: 80,
        idleMs: 1200,
        maxOutputTokens,
        planTier,
      };
    case "NORMAL":
    default:
      return {
        tier: "NORMAL",
        maxSegments: 2, // 🔥 4→2: 불필요한 API 왕복 절감 (2seg면 free 4K, pro 6K 충분)
        flushIntervalMs: 120,
        idleMs: 3000,
        maxOutputTokens,
        planTier,
      };
  }
}
