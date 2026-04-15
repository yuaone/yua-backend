import type { ChatRuntimeContext, ChatResponse } from "../types/chat-io";
import { runLegacyChat } from "../legacy/legacy-chat-engine-adapter";

export async function runNormalPath(ctx: ChatRuntimeContext): Promise<ChatResponse> {
  return runLegacyChat(ctx, {
    thinkingProfile: "NORMAL",
    reasoning: { summary: "auto", effort: "low" },
    maxSegments: 2,
    computePolicy: {
      tier: "NORMAL",
      maxSegments: 2,
      flushIntervalMs: 120,
      idleMs: 3000,
      // Legacy path — plan-tier unknown at this layer, default to free.
      // Real per-plan budgets flow via decideComputePolicy in the main path.
      maxOutputTokens: 2048,
      planTier: "free",
    },
  });
}
