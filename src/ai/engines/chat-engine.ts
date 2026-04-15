// 📂 src/ai/engines/chat-engine.ts
// 🔥 YUA ChatEngine — CLEAN SSOT BUILD (2025.12)
// 역할: 판단 + 오케스트레이션 ONLY

import { randomUUID } from "crypto";
import {
  runGlobalSafetyRuntime,
  runResponsibilitySafetyRuntime,
} from "../chat/runtime/safety-runtime";
import { runContextRuntime } from "../chat/runtime/context-runtime";
import { buildToolExecutionPlan } from "../tools/tool-plan-builder";
import type { ToolPlanItem } from "../tools/tool-plan-builder";
import { toYuaExecutionPlan } from "../tools/to-yua-execution-plan";
import { runVerifierLoop } from "../verifier/verifier-loop";
import type { ToolRunResult } from "../tools/tool-runner";
import { normalizeToolResults } from "../tools/tool-result-normalizer";
import { runPromptRuntime } from "../chat/runtime/prompt-runtime";
import { inferPersonaFromAnchors } from "../persona/persona-inference-engine";
import { PersonaPermissionEngine } from "../persona/persona-permission-engine";
import type { PersonaContext } from "../persona/persona-context.types";
import { defaultPersonaContext } from "../persona/persona-context.types";
import { JudgmentRuleAutoGenerator } from "../judgment/judgment-rule-auto-generator";
import { JudgmentRuleGovernor } from "../judgment/judgment-rule-governor";
import { judgmentFailureStore } from "../judgment/judgment-hook";
import { applyJudgmentToPath } from "../judgment/judgment-hook";
import { judgmentRegistry } from "../judgment/judgment-singletons";
import { JudgmentLearningLoop } from "../judgment/judgment-learning-loop";
import { decidePath, type PathType } from "../../routes/path-router";
import type { ChatMode } from "../chat/types/chat-mode";
import type { DecisionContext } from "../decision/decision-context.types";
import { OUTMODE } from "../chat/types/outmode";
import type { ToolGateDecision } from "../tools/tool-types";
import type { YuaExecutionPlan } from "yua-shared";
import { dispatchYuaExecutionPlan } from "../yua-tools/yua-tool-dispatcher";
import { generateMemoryCandidate } from "../memory/memory-candidate";
import type { MemoryCandidate } from "../memory/memory-candidate.type";
import { PersonaAggregator } from "../persona/persona-aggregator";
import { readDominantPersona } from "../persona/persona-aggregate-reader";
import type { ComputePolicy } from "../compute/compute-policy";
import { CrossMemoryWriter } from "../memory/cross/cross-memory.writer";
import { ReasoningSessionController } from "../reasoning/reasoning-session-controller";
 
import {
  checkClaimBoundaryViolation,
  type ClaimBoundary,
} from "../claim/claim-boundary-checker";
import { resolveTaskKind } from "../task/task-resolver";
import { dispatchExecution } from "../execution/execution-dispatcher";
import { detectInputSignals } from "../input/input-signal-detector";
import { extractInputPayload } from "../input/input-extractor";
import { executePlan } from "../execution/execution-entry";
import {
   CrossMemoryOrchestrator,
 } from "../memory/cross";
import { shouldAutoCommitMemory } from "../memory/memory-auto-commit";
import { buildMemoryStreamEvent } from "../memory/memory-stream-emitter";
import { MemoryManager } from "../memory/memory-manager";
import { detectMemoryIntent } from "../memory/memory-intent";
import type { MemoryScope } from "../memory/memory-scope-router";
import type { ExecutionPlan } from "../execution/execution-plan";
import type { ExecutionResult } from "../execution/execution-result";
import type { TurnIntent } from "../chat/types/turn-intent";
import {
  generateLanguageDecisionCandidate,
} from "../memory/memory-language-decision-candidate";
import {
  loadThreadStyleProfile,
  saveThreadStyleProfile,
} from "../style/style-profile.store";
import {
  detectStyleSignal,
} from "../style/detect-style-signal";
import {
  aggregateStyleSignal,
  createEmptyStyleProfile,
  buildStyleHint,
} from "../style/style-aggregator";
import {
  dedupMemoryCandidate,
} from "../memory/memory-dedup";
import { ensureUserProfile } from "../memory/user-profile-sync";
// 🔥 Suggestion Pipeline (SSOT)
import {
  SuggestionDecisionEngine,
} from "../suggestion/suggestion-decision-engine";
import {
  ContinuationSuggestionEngine,
} from "../suggestion/continuation-suggestion-engine";
import { FlowLogRepo } from "../suggestion/flow-log.repo";
import type { ResponseHint } from "../chat/types/response.final";
import type { LeadHint } from "../chat/types/lead-hint";
import { StreamEngine } from "./stream-engine"; // 경로 맞게 조정
import { StreamStage } from "yua-shared/stream/stream-stage";
import { ActivityKind } from "yua-shared/stream/activity";
import OpenAI from "openai";
import { SYSTEM_CORE_FINAL } from "../system-prompts/system-core.final";
import { resolveRuntimeModelId } from "../chat/runtime/openai-runtime";
import {
  buildOpenAIToolSchemas,
  executeOpenAITool,
  mapAllowedToolTypesToOpenAITools,
  type OpenAIToolName,
} from "../tools/openai-tool-registry";
import type { ResponseAffordanceVector } from "../decision/response-affordance";
import { ConversationStrategyEngine } from "../conversation/conversation-strategy-engine";
import { AnswerStateAnalyzer } from "../suggestion/answer-state-analyzer";
import { SelfCorrectionEngine } from "../selfcheck/self-correction-engine";
 import type { FailureSurface } from "../selfcheck/failure-surface-engine";
import {
  ResponsePressureEngine,
  type ResponsePressureInput,
} from "../conversation/response-pressure-engine";
 import type { SignalHints } from "../statistics/signal-hints";
 import { SignalRepo } from "../statistics/signal-repo";
 import type { YuaSuggestion } from "../../types/stream";
 import { AnswerBuffer } from "../suggestion/answer-buffer";
 import { MessageEngine } from "../engines/message-engine";
import type { AttachmentMeta } from "../chat/types/attachment.types";
import type { ResponseDensityHint } from "../chat/types/response-density";
import type { TrustedFactHint } from "../tools/tool-runner";
import type { ThinkingProfile } from "yua-shared";
import type { DbClient } from "../file-intel/vector/db";
import type { Embedder as FileEmbedder } from "../file-intel/vector/embedder";
import { ReasoningSessionRepo } from "../reasoning/reasoning-session.repo";
// 🔒 toYuaExecutionPlan is now the SSOT at ../tools/to-yua-execution-plan.ts
// and is imported above. The local function was removed to eliminate drift
// with design-engine.ts, which used to skip the attachments field.

// 🔒 ContextRuntime 전달 전용 정제
function normalizeTurnIntentForContext(
  intent?: TurnIntent
): "QUESTION" | "CONTINUATION" | "SHIFT" | undefined {
  if (!intent) return undefined;

  switch (intent) {
    case "QUESTION":
    case "CONTINUATION":
    case "SHIFT":
      return intent;

    // 🔥 REACTION / 기타는 ContextRuntime에 의미 없음
    default:
      return undefined;
  }
}

// 🔒 Strategy 전용 TurnIntent 정규화
function normalizeTurnIntentForStrategy(
  intent?: TurnIntent
): "QUESTION" | "CONTINUATION" | "SHIFT" {
  if (!intent) return "QUESTION";

  switch (intent) {
    case "QUESTION":
    case "CONTINUATION":
    case "SHIFT":
      return intent;
    default:
      // REACTION, UNKNOWN 등은 전략에서 무시
      return "QUESTION";
  }
}



function mapMomentumToDensity(
   momentum: "LOW" | "MEDIUM" | "HIGH"
 ): ResponseDensityHint {
   switch (momentum) {
     case "LOW":
       return "COMPACT";
     case "MEDIUM":
       return "NORMAL";
     case "HIGH":
       return "EXPANSIVE";
   }
 }

  function emitReasoningPanelsAsActivity(args: {
   threadId?: number;
   traceId?: string;
   panels?: ChatMeta["reasoningPanels"];
 }) {
   const { threadId, traceId, panels } = args;
   if (!threadId || !traceId || !panels?.length) return;

   for (const panel of panels) {
     StreamEngine.publish(threadId, {
       event: "activity",
       stage: StreamStage.THINKING,
       traceId,
       activity: {
         op: "ADD",
         item: {
           id: `reasoning:${traceId}:${panel.id}`,
           kind: ActivityKind.REASONING_SUMMARY,
           status: "OK",
           title: panel.title,
           inlineSummary: panel.items
             .map(i => i.title)
             .join(" · "),
           meta: {
             type: "REASONING_PANEL",
             source: panel.source,
             index: panel.index,
             items: panel.items,
           },
           at: Date.now(),
         },
       },
     });
   }
 }

 function normalizeToolOutput(input: unknown): string {
 const raw =
    typeof input === "string"
      ? input
      : JSON.stringify(input ?? "", null, 2);

  // HTML 제거
  const noHtml = raw.replace(/<[^>]*>/g, "");

  // 공백 압축
  const compact = noHtml.replace(/\s+/g, " ").trim();

  const HARD_CHAR_CAP = 20000;

  return compact.length > HARD_CHAR_CAP
    ? compact.slice(0, HARD_CHAR_CAP)
    : compact;
}


function mapCandidateScopeToMemoryScope(
  scope: MemoryCandidate["scope"],
  meta?: MemoryCandidate["meta"]
): MemoryScope {
  if (meta?.decisionHint === "ARCHITECTURE") {
    return "project_architecture";
  }

  if (meta?.decisionHint === "DECISION") {
    return "project_decision";
  }

  // MemoryCandidateScope is now aligned with MemoryScope — direct pass-through
  switch (scope) {
    case "user_preference":
      return "user_preference";
    case "user_profile":
      return "user_profile";
    case "user_research":
      return "user_research";
    case "project_architecture":
      return "project_architecture";
    case "project_decision":
      return "project_decision";
    case "general_knowledge":
    default:
      return "general_knowledge";
  }
}


export interface ChatMeta {
  threadId?: number;
  userId?: number;
  workspaceId?: string;
  instanceId?: string;
  stream?: boolean;
  turnIndex?: number;
  /**
   * UI locale from the NEXT_LOCALE cookie (frontend-owned). Passed
   * through chat-controller so prompt-runtime can prefer it over the
   * detected content language when enforcing output language.
   * Valid values mirror `yua-web/src/i18n/config.ts` LOCALES.
   */
  uiLocale?: string | null;
  mode?: ChatMode;
  outmode?: OUTMODE;
  thinkingProfile?: ThinkingProfile;
  computePolicy?: ComputePolicy;
  designMode?: boolean;
  /**
   * 🔒 SSOT: Runtime-only hints
   * - Decision 결과에 영향 ❌
   * - PromptRuntime / UI 참고용
   */
  runtimeHints?: {
    selfCorrection?: {
      kind: "REDUCE_CONFIDENCE" | "REDUCE_DEPTH" | "FORCE_VERIFY";
      patchedReasoning: NonNullable<ChatMeta["reasoning"]>;
    };
  };
  /**
   * 🔥 DesignEngine v2
   * - Non-binding analytical observations
   * - PromptBuilder reference only
   * - MUST NOT affect judgment or rules
   */
  memoryCommitted?: boolean;
  designHints?: {
    stage: "INTENT" | "CONSTRAINT" | "OPTIONS" | "RISKS" | "TRADEOFFS";
    observations: string[];
    confidence: number;
  }[];
  responseDensityHint?: import("../chat/types/response-density").ResponseDensityHint;
  conversationalOutcome?: import("../decision/conversational-outcome").ConversationalOutcome;
  turnFlow?: "NEW" | "FOLLOW_UP" | "ACK_CONTINUE" | "TOPIC_SHIFT";
  responseHint?: ResponseHint;
  leadHint?: LeadHint; // 🔥 추가 (ResponsePressure → PromptBuilder 전달)
  outputStyle?: 
    | "CONCISE"
    | "EXPLAINER"
    | "GUIDED_HUMAN"
    | "CONVERSATIONAL_EXPERT"
    | "DESIGNER";
  traceId?: string;
 prevTurnContinuity?: {
   anchorConfidence: number;
   continuityAllowed: boolean;
   contextCarryLevel: "RAW" | "SEMANTIC" | "ENTITY";
 };
  responseAffordance?: ResponseAffordanceVector;
  prevResponseAffordance?: ResponseAffordanceVector;
  conversationalMomentum?: "LOW" | "MEDIUM" | "HIGH";
  outputTransformHint?: 
  | "DELTA_ONLY"
  | "ROTATE"
  | "SUMMARIZE"
  | "CONCLUDE"
  | "SOFT_EXPAND";
  decisionPath?: PathType;
  planId?: string | number;
  toolGate?: ToolGateDecision;
  /**
   * 🔥 Vision Budget (SSOT)
   * - Decision → ToolGate → ExecutionEntry 전달 전용
   * - ChatEngine은 수정 ❌
   */
  visionBudget?: {
    allowOCR?: boolean;
    allowZoom?: boolean;
    allowCrop?: boolean;
    maxImages?: number;
  };
  verdict?: "APPROVE" | "BLOCK" | "DEFER" | "HOLD";
  memoryIntent?: "NONE" | "CONTEXT" | "ARCHITECTURE" | "DECISION" | "REMEMBER" | "IMPLICIT";
  memoryCandidate?: MemoryCandidate;
  activation?: {
    level: "FULL" | "LIMITED" | "SHADOW";
    reason?: string;
  };
  claimBoundary?: ClaimBoundary;

  /**
   * 🔒 SSOT: Deterministic Reasoning Deltas (READ ONLY)
   * - DecisionOrchestrator에서 생성
   * - ChatEngine은 emit만 담당
   */
  reasoningPanels?: {
    id: string;
    source: "decision" | "tool_gate" | "prompt_runtime";
    title: string;
    index: number;
    status: "RUNNING" | "DONE";
    items: {
      id: string;
      title: string;
      body: string;
      ts: number;
    }[];
  }[];
    /* -------------------------------------------------- */
  /* 🧠 Reasoning Snapshot (SSOT / READ-ONLY)           */
  /* -------------------------------------------------- */
  reasoning?: {
  intent: "ask" | "design" | "debug" | "decide" | "execute";
  userStage: "confused" | "ready" | "looping";
  domain: "dev" | "biz" | "law" | "etc";
  confidence: number;
  cognitiveLoad: "low" | "medium" | "high";
  depthHint: "shallow" | "normal" | "deep";
  nextAnchors: (
    | "VISION_PRIMARY"
    | "REFINE_INPUT"
    | "EXPAND_SCOPE"
    | "VERIFY_LOGIC"
    | "COMPARE_APPROACH"
    | "IMPLEMENT"
    | "SUMMARIZE"
    | "NEXT_STEP"
    | "BRANCH_MORE"
  )[];
};
  turnIntent?: TurnIntent;
  attachments?: AttachmentMeta[];
  sanitizedMessage?: string;
  failureSurface?: FailureSurface;
  executionPlan?: ExecutionPlan;
  executionResult?: ExecutionResult;
  fileRag?: {
    db: DbClient;
    embedder: FileEmbedder;
    workspaceId: string;
  };
  fileSessionId?: string;
  fileSignals?: {
    hasFile: boolean;
    hasFileIntent: boolean;
    relevanceScore: number;
  };
  fileRagForceOnce?: boolean;
  fileRagConfidence?: number;
  bypassedLLM?: boolean;

  /**
   * Slash-command selected skill slug (from frontend "/" input).
   * Forwarded to prompt-runtime to pin the skill in the skills block.
   */
  skillSlug?: string;
}

export type ChatEngineResult =
  | {
      ok: false;
      engine: "chat-error";
      message: string;
    }
  | {
      ok: true;
      engine: "chat";
      persona: string;
      mode: ChatMode;
      path: PathType;
      prompt: string;
      meta: ChatMeta;
    }
  | {
      ok: true;
      engine: "chat";
      directResponse: true;
      text: string;
      meta: ChatMeta;
    };

 /* -------------------------------------------------- */
 /* 🔥 PHASE 4: Self-Learning Engines (SSOT)           */
 /* -------------------------------------------------- */

 const autoRuleGenerator = new JudgmentRuleAutoGenerator(
   judgmentFailureStore,
   judgmentRegistry
 );

 const ruleGovernor = new JudgmentRuleGovernor(
   judgmentRegistry
 );

  const judgmentLearningLoop = new JudgmentLearningLoop(
   judgmentFailureStore,
   judgmentRegistry
 );

export const ChatEngine = {
  attachFileAnalysisResult(
    prompt: string,
    executionResult?: ExecutionResult
  ): string {
    if (!executionResult || executionResult.ok !== true) return prompt;

    let safeOutput = "";

    try {
      if (typeof executionResult.output === "string") {
        safeOutput = executionResult.output;
      } else {
        safeOutput = JSON.stringify(executionResult.output, null, 2);
      }
    } catch {
      safeOutput = "[UNSERIALIZABLE_FILE_ANALYSIS_RESULT]";
    }

    // 🔒 Hard cap to prevent token explosion
    if (safeOutput.length > 3000) {
      safeOutput =
        safeOutput.slice(0, 3000) + "\n...[TRUNCATED]";
    }

    return (
      `${prompt}\n\n` +
      `[FILE_ANALYSIS_RESULT]\n` +
      `${safeOutput}`
    );
  },
  async generateResponse(
    message: string,
    persona: { role: string },
    meta: ChatMeta = {}
  ): Promise<ChatEngineResult> {
    try {
            // 🔥 FIX Bug 1: workspaceId ↔ instanceId 정규화 — 둘 중 하나만 있어도 양쪽 세팅
            if (!meta.workspaceId && meta.instanceId) meta.workspaceId = String(meta.instanceId);
            if (!meta.instanceId && meta.workspaceId) meta.instanceId = String(meta.workspaceId);

            // 🔒 SSOT: Self Inquiry Detection (ChatEngine ONLY)
      const isSelfInquiry =
        /너는 누구|정체성|원칙|너의 규칙|self memory|자기인식/i.test(message);

console.log("[DEBUG][CHAT_ENGINE_INPUT_META]", {
  messageLength: message?.length ?? 0,
});

    const traceId = meta.traceId ?? randomUUID();
    meta.traceId = traceId;
    // 🔒 SSOT: IMAGE_GENERATION must bypass ChatEngine/PromptRuntime
    if (meta.executionPlan?.task === "IMAGE_GENERATION") {
      return {
        ok: true,
        engine: "chat",
        persona: persona.role,
        mode: meta.mode ?? "NORMAL",
        path: meta.decisionPath ?? "NORMAL",
        prompt: "",
        meta,
      };
    }

       /* -------------------------------------------------- */
    /* 1️⃣ Reasoning (SSOT: DecisionContext ONLY)         */
    /* -------------------------------------------------- */

    if (!meta.reasoning) {
      throw new Error(
        "[SSOT_VIOLATION] meta.reasoning is missing in ChatEngine"
      );
    }

        // 🔒 SSOT: Reasoning은 DecisionOrchestrator의 단일 결과
    // ChatEngine에서 재계산 / 수정 / 파생 금지
    let reasoning = meta.reasoning;
    Object.freeze(reasoning);

    console.log("[DEBUG][REASONING][SSOT]", {
      intent: reasoning.intent,
      stage: reasoning.userStage,
      depth: reasoning.depthHint,
      load: reasoning.cognitiveLoad,
      anchors: reasoning.nextAnchors,
      confidence: reasoning.confidence,
    });

    // 1) Behavior hint (anchors 기반)
    const personaHint = inferPersonaFromAnchors(
      reasoning.nextAnchors ?? [],
      Number(reasoning.confidence ?? 0)
    );

// 🔥 PERF: DB 쿼리 3개 병렬화 (순차 → Promise.all)
const [reasoningSessionId, aggregatedPersona] = await Promise.all([
  // ReasoningSession 생성
  (meta.stream && meta.threadId)
    ? ReasoningSessionRepo.create({
        threadId: meta.threadId,
        traceId,
        turnId: meta.turnIndex ?? 0,
        mode: meta.thinkingProfile === "DEEP" ? "VERIFY" : "NORMAL",
      })
    : Promise.resolve(null),
  // Aggregated Persona 읽기
  (meta.userId && meta.instanceId)
    ? readDominantPersona(String(meta.instanceId), Number(meta.userId))
    : Promise.resolve(null),
]);

// PersonaAggregator: fire-and-forget (best-effort)
if (meta.userId && meta.instanceId) {
  PersonaAggregator.ingest({
    userId: Number(meta.userId),
    workspaceId: String(meta.instanceId),
    hint: personaHint,
  }).catch((e) => console.warn("[PERSONA_AGGREGATOR][SKIPPED]", e));
}

    const isStreaming = meta.stream === true;
const reasoningController =
  meta.stream && meta.threadId && reasoningSessionId
    ? new ReasoningSessionController({
        threadId: meta.threadId,
        traceId: meta.traceId!,
        mode: meta.thinkingProfile === "DEEP" ? "DEEP" : "NORMAL",
        sessionId: reasoningSessionId,
      })
    : null;

    /* -------------------------------------------------- */
    /* 2️⃣ Safety + Policy                                */
    /* -------------------------------------------------- */
  const globalSafety = runGlobalSafetyRuntime({
  input: message,
  personaRole: persona.role,
  reasoning,
});

    if (!globalSafety.ok) {
      // 🔒 SSOT: HARD BLOCK만 엔진 중단
      return {
        ok: false,
        engine: "chat-error",
        message: globalSafety.reason,
      };
    }

// ✅ 여기부터는 ok === true 보장
let policy = globalSafety.policy;

// 🔥 DEV / MOCK MODE: Search 강제 허용 (SSOT SAFE)
if (process.env.YUA_SEARCH_MOCK === "true") {
  policy = {
    ...policy,
    allowSearch: true,
  };
}

// 🔍 DEBUG (강력 추천)
console.log("[DEBUG][SAFETY_POLICY_FINAL]", policy);

console.log("[DEBUG][SAFETY_POLICY]", {
  allowSearch: policy.allowSearch,
  allowMemory: policy.allowMemory,
});

    /* -------------------------------------------------- */
    /* 3️⃣ Path 결정 + Mode 확정 (SSOT)                  */
    /* -------------------------------------------------- */

// ✅ SSOT: DecisionCtx가 주면 그게 최종 path
let path: PathType;

if (meta.decisionPath) {
  path = meta.decisionPath;
} else {
  const hintedPath: PathType = decidePath({
    content: message,
    source: "USER",
    traceId,
    receivedAt: Date.now(),
  });

  // 🔒 Judgment 적용 (SSOT, async, instance-aware)
  path = await applyJudgmentToPath({
    input: message,
    initialPath: hintedPath,
    instanceId: meta.instanceId ?? "default-instance",
    threadId: meta.threadId,
  });
}

// 🔒 사용자 요청에서 RESEARCH 차단
if (path === "RESEARCH" && !meta.instanceId) {
  console.warn("[PATH_DOWNGRADE]", {
    from: "RESEARCH",
    to: "NORMAL",
    reason: "missing instanceId",
  });
  path = "NORMAL";
}


// 🔒 SSOT: Mode는 DecisionContext에서만 온다
if (!meta.mode) {
  throw new Error("[SSOT_VIOLATION] meta.mode is missing in ChatEngine");
}
const mode: ChatMode = meta.mode;

// 🔒 OUTMODE 결정 (SSOT — 단순 신호만)
// ChatEngine은 "출력 목적"만 전달
// 해석/톤/문서화는 PromptRuntime 책임

// 🔒 SSOT: outmode는 DecisionContext 우선
if (!meta.outmode) {
  meta.outmode =
    meta.thinkingProfile === "DEEP"
      ? OUTMODE.DEEP
      : OUTMODE.NORMAL;
}
    /**
     * 🔥 SSOT FIX
     * - STREAM 응답에서는 DOCUMENT outmode 금지
     * - FINAL 이후 문서 렌더 전이 방지
     */
    if (meta.stream === true && meta.outmode === OUTMODE.DOCUMENT) {
      console.warn("[SSOT_FIX][OUTMODE_BLOCKED_IN_STREAM]", {
        traceId: meta.traceId,
      });
      meta.outmode = OUTMODE.NORMAL;
    }


      /* -------------------------------------------------- */
  /* 🔍 DEBUG — ChatEngine Entry Snapshot (SSOT)        */
  /* -------------------------------------------------- */
  console.log("[DEBUG][CHAT_ENGINE]", {
    threadId: meta.threadId,
    traceId: meta.traceId,
    stream: meta.stream,
    mode,
    outmode: meta.outmode,
    path,
  });

 // 🔒 SSOT: Reasoning Panels → Activity (Single Emit)
 if (meta.stream === true) {
   emitReasoningPanelsAsActivity({
     threadId: meta.threadId,
     traceId: meta.traceId,
     panels: meta.reasoningPanels,
   });
 }

 if (reasoningController) {
 await StreamEngine.publishMeta({
   threadId: meta.threadId!, // ✅ stream+controller 보장
   traceId: meta.traceId!,
   meta: {
     firstThinkingAt: Date.now(),
   },
 });
   reasoningController.beginStage("decision");
   reasoningController.appendTrace({
     path,
     mode,
     confidence: meta.reasoning?.confidence,
   });
   await reasoningController.completeStage();
 }

 let toolRuntimeContext: string | undefined;

    /* -------------------------------------------------- */
    /* 4-1️⃣ OpenAI Tool Calling (max 2 iterations)       */
    /* -------------------------------------------------- */
    const toolGate = meta.toolGate;
    const allowSearch = policy.allowSearch === true;
 let allowedOpenAITools: OpenAIToolName[] = [];

 if (toolGate) {
   allowedOpenAITools = mapAllowedToolTypesToOpenAITools(
     toolGate.allowedTools,
     allowSearch
   );
 }

    if (allowedOpenAITools.length > 0 && process.env.OPENAI_API_KEY) {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const model = resolveRuntimeModelId(mode);
      const tools = buildOpenAIToolSchemas(allowedOpenAITools);
      const toolContextParts: string[] = [];
      const toolCallKeys = new Set<string>();

      // 🔥 스트리밍에서는 tool pre-pass 스킵 — ExecutionEngine이 자체 toolGate로 도구 결정
      const skipStreamingToolPrepass = meta.stream === true;
      if (!skipStreamingToolPrepass) {
      for (let iter = 0; iter < 2; iter++) {
        const input = [
          {
            type: "message",
            role: "system",
            content: [{ type: "input_text", text: SYSTEM_CORE_FINAL }],
          },
          {
            type: "message",
            role: "developer",
            content: [
              {
                type: "input_text",
                text:
                  "Tool selection only. Call a tool only if it is necessary. " +
                  "If no tool is needed, respond normally without tool calls.",
              },
            ],
          },
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: message },
              ...(toolContextParts.length > 0
                ? [
                    {
                      type: "input_text",
                      text:
                        "\n\n[TOOL_RESULTS]\n" +
                        toolContextParts.join("\n\n"),
                    },
                  ]
                : []),
            ],
          },
        ];

        const res: any = await client.responses.create({
          model,
          input: input as any,
          tools: tools as any,
          tool_choice: "auto",
        } as any);

        const output = Array.isArray(res?.output) ? res.output : [];
        const calls = output.filter(
          (it: any) => it?.type === "function_call" && typeof it?.name === "string"
        );

        if (calls.length === 0) break;

        for (const call of calls) {
          const toolName = call.name as OpenAIToolName;
          if (!allowedOpenAITools.includes(toolName)) continue;

          const rawArgs =
            typeof call.arguments === "string"
              ? call.arguments
              : typeof call.arguments_json === "string"
              ? call.arguments_json
              : JSON.stringify(call.arguments ?? {});

          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = rawArgs ? JSON.parse(rawArgs) : {};
          } catch {
            parsedArgs = {};
          }

          const key = `${toolName}:${JSON.stringify(parsedArgs)}`;
          if (toolCallKeys.has(key)) continue;
          toolCallKeys.add(key);

          const startedAt = Date.now();
          const result = await executeOpenAITool(toolName, parsedArgs, {
            traceId: meta.traceId,
            allowSearch,
          });
          const latency = Date.now() - startedAt;

          console.log("[OPENAI_TOOL_CALL]", {
            toolName,
            arguments: parsedArgs,
            latencyMs: latency,
            resultSize: result.size ?? 0,
          });

          const safeToolOutput = normalizeToolOutput(
            result.output ?? result.error ?? null
          );

          toolContextParts.push(
            `[TOOL:${toolName}] ${safeToolOutput}`
          );
        }
      }
      }

      if (toolContextParts.length > 0) {
        toolRuntimeContext = toolContextParts.join("\n\n");
      }
    }

    /* -------------------------------------------------- */
    /* 5️⃣ RESEARCH Runtime                               */
    /* -------------------------------------------------- */
    const shouldResearch = false;
   
  // 🔒 workspace boundary 확정 (SSOT)
  // 👉 RESEARCH 경로에서만 강제
  let workspaceId: string | undefined;

 if (path === "RESEARCH") {
   workspaceId = meta.instanceId;
 }

  const researchResult = { researchContext: undefined as string | undefined };

        /* -------------------------------------------------- */
    /* 🧠 RAW CONVERSATION TURNS (SSOT)                  */
    /* -------------------------------------------------- */

    // 🔥 PERF: MEGA Group A — 모든 독립 DB 쿼리 병렬 실행
    const _megaStart = Date.now();
    const [conversationTurns, , crossMemoryResult, _signalResult, _styleProfileResult, , _userPrefsResult, _contextResult] = await Promise.all([
      // 1. Message history
      (async () => {
        if (!meta.threadId) return [] as { role: "user" | "assistant" | "system"; content: string }[];
        try {
          const historyDepth =
            meta.thinkingProfile === "DEEP" ? 30
              : meta.thinkingProfile === "NORMAL" ? 20
              : 12;
          const recentMessages =
            (await MessageEngine.listMessages(meta.threadId))
              .slice(-historyDepth);
          return recentMessages.map(m => {
            const turn: any = {
              role: m.role as "user" | "assistant" | "system",
              content: m.content,
            };
            // Pass tool_context + artifact_refs from meta (Phase B + E)
            const meta = typeof m.meta === "object" && m.meta ? m.meta as Record<string, unknown> : null;
            if (meta?.tool_context && Array.isArray(meta.tool_context)) {
              turn.toolContext = meta.tool_context;
            }
            if (meta?.artifact_refs && Array.isArray(meta.artifact_refs)) {
              turn.artifactRefs = meta.artifact_refs;
            }
            return turn;
          });
        } catch (e) {
          console.warn("[CHAT_ENGINE][CONVERSATION_TURNS_SKIP]", e);
          return [] as { role: "user" | "assistant" | "system"; content: string }[];
        }
      })(),

      // 2. User profile + Persona (best-effort, fire-and-forget)
      (async () => {
        if (!meta.userId || !meta.instanceId) return;
        await Promise.all([
          ensureUserProfile({
            userId: Number(meta.userId),
            workspaceId: String(meta.instanceId),
          }).catch(e => console.warn("[USER_PROFILE_SYNC][SKIPPED]", e)),
          // PersonaAggregator.ingest는 이미 초기 병렬화에서 fire-and-forget 실행됨 (중복 제거)
        ]);
      })(),

      // 3. Cross-Memory attach
      (async () => {
        try {
          const cross = await CrossMemoryOrchestrator.attach({
            decision: {
              sanitizedMessage: meta.sanitizedMessage ?? message,
              reasoning: meta.reasoning!,
              turnIntent: meta.turnIntent,
              conversationalOutcome: meta.conversationalOutcome,
              prevTurnContinuity: meta.prevTurnContinuity,
              memoryIntent: meta.memoryIntent ?? "NONE",
              responseAffordance: meta.responseAffordance,
              threadId: meta.threadId,
              userId: meta.userId,
              instanceId: meta.instanceId,
              traceId: meta.traceId!,
            } as DecisionContext,
          });
          return cross.memoryContext;
        } catch (e) {
          console.warn("[CROSS_MEMORY][SKIPPED]", e);
          return undefined;
        }
      })(),

      // 🔥 Group C items (was separate Promise.all after contextRuntime)
      // Signal hints
      (async () => {
        try {
          const [existenceDrift, confidenceTrend] = await Promise.all([
            SignalRepo.getLatest<{ delta?: number }>({ kind: "SEARCH_FACET_TREND", scope: "GLOBAL", target: "existence" }),
            SignalRepo.getLatest<{ drop?: number }>({ kind: "CONFIDENCE_TREND", scope: "GLOBAL" }),
          ]);
          const hints: any = {};
          if (existenceDrift && existenceDrift.confidence != null && existenceDrift.confidence >= 0.6 && typeof existenceDrift.value?.delta === "number") {
            hints.facetDrift = { existence: existenceDrift.value!.delta >= 0.2 ? "UP" : existenceDrift.value!.delta <= -0.2 ? "DOWN" : undefined };
          }
          if (confidenceTrend && confidenceTrend.confidence != null && confidenceTrend.confidence >= 0.6 && typeof confidenceTrend.value?.drop === "number" && confidenceTrend.value.drop >= 0.2) {
            hints.maxSuggestionCap = 1; hints.conservativeSuggestions = true;
          }
          return hints;
        } catch { return {}; }
      })(),

      // Style profile
      (async () => meta.threadId ? loadThreadStyleProfile(meta.threadId) : null)(),

      // PersonaPermission — verdict 의존성 때문에 pre-fetch 불가. 아래에서 실제 verdict로 호출.
      Promise.resolve(null),

      // getUserPrefs (was sequential at line ~1635)
      (async () => {
        try {
          if (!meta.userId) return null;
          const { getUserPrefs } = await import("../../db/repo/user-prefs.repo.js");
          return await getUserPrefs(Number(meta.userId));
        } catch { return null; }
      })(),

      // 🔥 PERF: ContextRuntime merged into MegaA (was sequential after MegaA — no dependency on MegaA outputs)
      (async () => {
        try {
          return await runContextRuntime({
            threadId: meta.threadId,
            workspaceId: meta.instanceId,
            userId: meta.userId ? Number(meta.userId) : undefined,
            allowMemory:
              policy.allowMemory === true &&
              (meta.memoryIntent === "REMEMBER" || meta.memoryIntent === "IMPLICIT" || meta.turnIntent !== "SHIFT"),
            isSelfInquiry,
            turnIntent: normalizeTurnIntentForContext(meta.turnIntent),
            userMessageLength: message.length,
            responseAffordance: meta.responseAffordance,
            searchResults: [],
            researchContext:
              path === "RESEARCH"
                ? researchResult.researchContext
                : undefined,
            mode: mode === "BENCH" ? "NORMAL" : mode,
          });
        } catch (e) {
          console.warn("[CONTEXT_RUNTIME_PARALLEL][SKIPPED]", e);
          return null;
        }
      })(),
    ]);

    console.log("[PERF][MEGA_GROUP_A]", { ms: Date.now() - _megaStart });
    const crossMemoryContext = crossMemoryResult;

    console.log("[CROSS_MEMORY][ATTACHED]", {
      threadId: meta.threadId,
      traceId: meta.traceId,
      hasMemory: Boolean(crossMemoryContext),
    });
/* -------------------------------------------------- */
/* 5️⃣-1️⃣ Research Summary (READ-ONLY)                */
/* -------------------------------------------------- */

let researchSummary: string | undefined;
let claimBoundary: ClaimBoundary | undefined;

meta.claimBoundary = claimBoundary;

const baseConstraints = crossMemoryContext
  ? [crossMemoryContext]
  : undefined;

    /* -------------------------------------------------- */
    /* 6️⃣ Context Runtime                                */
    /* -------------------------------------------------- */
 // 🔥 PERF: ContextRuntime now runs in MegaA parallel — use result from there
 const context = _contextResult ?? {
   memoryContext: undefined,
   trustedFacts: [],
   constraints: baseConstraints,
   anchorConfidence: 0,
   continuityAllowed: true,
   contextCarryLevel: "ENTITY" as const,
 };

console.log("[PERF][CONTEXT_RUNTIME]", { note: "merged_into_mega_a" });
console.log("[DEBUG][CONTEXT_RUNTIME_OUT]", {
  hasMemoryContext: !!context.memoryContext,
  trustedFactsCount: context.trustedFacts?.length ?? 0,
  constraints: context.constraints,
  anchorConfidence: context.anchorConfidence,
  continuityAllowed: context.continuityAllowed,
  contextCarryLevel: context.contextCarryLevel,
});

/* -------------------------------------------------- */
/* 🧠 FAILURE SURFACE ANALYSIS (SSOT)                 */
/* -------------------------------------------------- */

 // 🔒 SSOT: failureSurface는 Decision에서 이미 계산되어 meta로 전달됨
 const failureSurface: FailureSurface | undefined =
   meta.failureSurface;

    /* -------------------------------------------------- */
    /* 🔒 PHASE 8: Runtime Signal → SignalHints (SSOT)   */
    /* -------------------------------------------------- */

    // 🔥 PERF: Group C — pre-fetched from MEGA Group A above
    let signalHints: SignalHints = {};
    const signalResult = _signalResult ?? {};
    const styleProfileResult = _styleProfileResult;

    signalHints = signalResult;

/* -------------------------------------------------- */
/* 🧠 COMPLETION + SELF CORRECTION (SSOT)             */
/* -------------------------------------------------- */

const correction = SelfCorrectionEngine.decide({
  reasoning,
  completion: {
    status: "INCOMPLETE",
    reason: "OPEN_BRANCH",
  },
  failureSurface: failureSurface,
});

if (
  correction === "REDUCE_CONFIDENCE" ||
  correction === "REDUCE_DEPTH" ||
  correction === "FORCE_VERIFY"
) {
  const patched = { ...reasoning };

  if (correction === "REDUCE_CONFIDENCE") {
    patched.confidence = Math.max(0.4, patched.confidence - 0.15);
  }

  if (correction === "REDUCE_DEPTH") {
    patched.depthHint = "shallow";
  }

  if (correction === "FORCE_VERIFY") {
    patched.nextAnchors = Array.from(
      new Set([...patched.nextAnchors, "VERIFY_LOGIC"])
    );
  }

  meta.runtimeHints = {
    ...(meta.runtimeHints ?? {}),
    selfCorrection: {
      kind: correction,        // ✅ 타입 안전
      patchedReasoning: patched,
    },
  };
}



/* -------------------------------------------------- */
/* 🎨 STYLE PROFILE (SSOT)                            */
/* -------------------------------------------------- */

let styleProfile = styleProfileResult;

if (!styleProfile) {
  styleProfile = createEmptyStyleProfile();
}

 // 🔒 SSOT: turnIndex는 styleProfile.samples
 const turnIndex = styleProfile.samples ?? 0;
 meta.turnIndex = turnIndex;

const language = "unknown";


const styleSignal = detectStyleSignal({
  text: message,
  language,
  turnIndex,
});

styleProfile = aggregateStyleSignal(
  styleProfile,
  styleSignal,
  turnIndex
);


/* -------------------------------------------------- */
/* 🔥 STEP 6: Responsibility Safety (DEEP ONLY)      */
/* -------------------------------------------------- */
if (mode === "DEEP") {
  const responsibility = runResponsibilitySafetyRuntime({
    reasoning,
  });

  if (responsibility.restrictAnswer) {
    meta.activation = {
      level: "LIMITED",
      reason: "responsibility_safety",
    };

    if (responsibility.constraints) {
      meta.activation.reason +=
        ": " + responsibility.constraints.join(", ");
    }
  }
}

        /* -------------------------------------------------- */
    /* 🔧 PHASE 7-2: Tool Execution + Verification (SSOT) */
    /* -------------------------------------------------- */
    let toolFacts: TrustedFactHint[] | undefined;
    let signals: import("../signals/yua-signal.types").YuaSignal[] | undefined;
    
    if (meta.toolGate && meta.toolGate.toolLevel !== "NONE") {
      if (!meta.workspaceId) {
        throw new Error("WORKSPACE_ID_REQUIRED_FOR_TOOL_EXECUTION");
      }
      const plan = buildToolExecutionPlan({
        message,
        path,
        toolGate: meta.toolGate,
        executionTask: meta.toolGate.executionTask,
      });

      console.log("[DEBUG][TOOL_PLAN]", {
      toolLevel: meta.toolGate.toolLevel,
      items: plan.items,
      });


      if (plan.items.length > 0) {
        const results: ToolRunResult[] = [];

        for (const item of plan.items) {
          const startedAt = Date.now();

          const yuaPlan = toYuaExecutionPlan(item, meta.attachments);
          // Null means the item was intentionally skipped (e.g. DOCUMENT_BUILDER
          // with zero file attachments). Don't dispatch an empty FILE_ANALYSIS.
          if (!yuaPlan) continue;
          const { result: yuaResult } = await dispatchYuaExecutionPlan(
            yuaPlan as unknown as YuaExecutionPlan,
            {
              traceId: meta.traceId ?? randomUUID(),
              workspaceId: meta.workspaceId,
              threadId: meta.threadId,
            }
          );

          const toolResultForVerifier =
            (yuaResult as any)?.output ?? yuaResult;

          const verifier = await runVerifierLoop({
            tool: item.tool,
            toolResult: toolResultForVerifier,
            baseConfidence: Number(reasoning.confidence ?? 0),
            budget: meta.toolGate.verifierBudget,
          });

          const r: ToolRunResult = {
            tool: item.tool,
            rawResult: toolResultForVerifier,

            verified: verifier.passed,
            confidence: verifier.confidence,
            verifierReason: verifier.reason,

            verifierUsed: verifier.verifierUsed,
            verifierFailed: verifier.verifierFailed,

            toolScoreDelta: verifier.toolScoreDelta,

            toolSucceeded: verifier.passed,
            toolLatencyMs: Date.now() - startedAt,

            ok: verifier.passed,
            result: verifier.passed ? toolResultForVerifier : undefined,
          };

          StreamEngine.setLastToolResult(meta.threadId!, {
            tool: item.tool,
            result: r.result,
            confidence: r.confidence,
          });

          results.push(r);
        }

        const normalized = normalizeToolResults(results);
        toolFacts =
          normalized.trustedFacts.length > 0
            ? normalized.trustedFacts
            : undefined;
        signals = normalized.signals;
      }
 if (reasoningController) {
   reasoningController.beginStage("tool_plan");
   reasoningController.appendTrace({
     toolLevel: meta.toolGate?.toolLevel,
   });
   await reasoningController.completeStage();
 }
    }

    
    /* -------------------------------------------------- */
    /* 🔥 SSOT: MARKET_DATA PRIMARY ANSWER SHORT-CIRCUIT */
    /* -------------------------------------------------- */

    const marketFacts = toolFacts?.filter(
      f => f.kind === "MARKET_SERIES"
    );

 if (
   marketFacts &&
   marketFacts.length > 0 &&
   meta.stream !== true
 ) {
   const answer = marketFacts
     .map((fact) => {
       const latest = fact.latest?.fields;
       return [
         `📈 ${fact.market} (${fact.symbol})`,
         `기간: ${fact.coverage.start} ~ ${fact.coverage.end}`,
         latest
           ? `종가: ${latest.close}, 시가: ${latest.open}, 고가: ${latest.high}, 저가: ${latest.low}, 거래량: ${latest.volume}`
           : "최신 데이터 없음",
         fact.isEstimated ? "※ 해당 값은 추정치입니다." : undefined,
       ]
         .filter(Boolean)
         .join("\n");
     })
     .join("\n\n");

   return {
     ok: true,
     engine: "chat",
     persona: persona.role,
     mode,
     path,
     prompt: answer,
     meta,
   };
 }
 
    console.log("[DEBUG][PROMPT_RUNTIME_IN]", {
  persona: persona.role,
  mode,
  hasMemoryContext: !!context.memoryContext,
  hasTrustedFacts:
    (context.trustedFacts?.length ?? 0) > 0 || !!toolFacts,
  constraints: context.constraints,
  hasResearchContext: !!researchResult.researchContext,
});

/* -------------------------------------------------- */
/* 🔥 PHASE 6-2: Input Signal Detection (SSOT)        */
/* -------------------------------------------------- */

const inputSignals = detectInputSignals({
  message,
  attachments: meta.attachments,
});

 const extractedPayload = extractInputPayload({
   message,
   attachments: meta.attachments,
 });



/* -------------------------------------------------- */
/* 🔥 PHASE 6: Task → ExecutionPlan (SSOT)            */
/* -------------------------------------------------- */

 // 🔒 SSOT: Evidence Snapshot은 ChatEngine에서 조합
 const evidence = {
   hasImage: inputSignals.hasImage,
   hasCodeBlock: inputSignals.hasCodeBlock,
   hasCodeIntent: inputSignals.hasCodeIntent,
   hasErrorLog: inputSignals.hasErrorLog,
   hasTypeError:
     inputSignals.hasErrorLog &&
     /(TypeError|ts\d{4})/i.test(message),
   hasRuntimeError:
     inputSignals.hasErrorLog &&
     /(ReferenceError|RangeError|stack trace|exception)/i.test(message),
 };

// 🔒 SSOT: TaskKind resolve
// - executionPlan이 이미 있으면 재결정 ❌
// - 없을 때만 단일 resolve
      const task =
        meta.executionPlan?.task ??
        resolveTaskKind({
          message,
          reasoning,
          ...evidence,
        });

 // 🔒 SSOT: TaskKind는 Decision.executionPlan이 있을 경우 재결정 금지

  let executionPlan: ExecutionPlan | undefined =
   meta.executionPlan ?? undefined;
// 🔒 SSOT: IMAGE_ANALYSIS는 DecisionOrchestrator에서만 생성

 const imageAttachments =
   meta.attachments
     ?.filter(
       (a): a is { kind: "image"; url: string } =>
         a.kind === "image" && typeof a.url === "string"
     )
     .map(a => ({
       kind: "image" as const,
       url: a.url,
     }));

 let executionResult: ExecutionResult | undefined = meta.executionResult;

 const isFileStructureQuery =
   /list files|folder structure|what files|what is inside|show contents|list contents|파일\s*목록|폴더\s*구조|내용\s*목록|안에\s*뭐/i.test(
     message
   );

 if (
   meta.executionPlan?.task === "FILE_INTELLIGENCE" &&
   executionResult?.ok === true &&
   isFileStructureQuery
 ) {
   let formattedOutput = "";
   try {
     if (typeof executionResult.output === "string") {
       formattedOutput = executionResult.output;
     } else {
       formattedOutput = JSON.stringify(executionResult.output, null, 2);
     }
   } catch {
     formattedOutput = "[UNSERIALIZABLE_FILE_INTELLIGENCE_RESULT]";
   }

   return {
     ok: true,
     engine: "chat",
     directResponse: true,
     text: formattedOutput,
     meta: {
       ...meta,
       executionResult,
       bypassedLLM: true,
     },
   };
 }

 if (!executionPlan && task !== "DIRECT_CHAT") {
   executionPlan = await dispatchExecution({
     task,
     message,
     reasoning,
    imageData: extractedPayload.imageData,
    codeBlock: extractedPayload.codeBlock,
    errorLog: extractedPayload.errorLog,
   });

  meta.attachments
    ?.filter(
      (a): a is { kind: "image"; url: string } =>
        a.kind === "image" && typeof a.url === "string"
    )
    .map(a => ({
      kind: "image" as const,
      url: a.url,
    }));
 }
 
 if (executionPlan && !meta.executionPlan) {
   meta.executionPlan = executionPlan;
 }


if (!meta.responseAffordance) {
  console.warn("[PRESSURE][SKIP]", {
    reason: "MISSING_AFFORDANCE",
    threadId: meta.threadId,
  });
     // 🔒 SSOT SAFE FALLBACK
      meta.responseAffordance = {
        describe: 0.4,
        expand: 0.4,
        branch: 0.2,
        clarify: 0.1,
        conclude: 0.25,
      };
}

const pressureInput: ResponsePressureInput = {
  affordance: meta.responseAffordance!,
  failureSurface: failureSurface,
  implementationMode:
    meta.executionPlan?.task === "CODE_GENERATION" ||
    meta.executionPlan?.task === "REFACTOR" ||
    meta.executionPlan?.task === "TYPE_ERROR_FIX" ||
    meta.executionPlan?.task === "RUNTIME_ERROR_FIX",
};

const { pressure, leadHint, conversationalMomentum  } =
  ResponsePressureEngine.decide(pressureInput);

  
meta.leadHint = leadHint;
meta.conversationalMomentum = conversationalMomentum;

meta.responseDensityHint = mapMomentumToDensity(
  conversationalMomentum
  );

// 🔥 비개발자 UX bias (SSOT)
if (
  reasoning.domain !== "dev" &&
  leadHint === "SOFT"
) {
      const patchedReasoning = {
        ...reasoning,
        confidence: Math.min(1, reasoning.confidence + 0.1),
      };
  meta.runtimeHints = {
    ...(meta.runtimeHints ?? {}),
    selfCorrection: {
      kind: "REDUCE_CONFIDENCE",
      patchedReasoning: patchedReasoning,
    },
  };
}


console.log("[DEBUG][RESPONSE_PRESSURE]", {
  pressure,
  leadHint,
  domain: reasoning.domain,
  confidence: reasoning.confidence,
  depth: reasoning.depthHint,
});

const relaxOutputConstraints =
  meta.executionPlan?.task === "CODE_GENERATION" ||
  meta.executionPlan?.task === "REFACTOR" ||
  meta.executionPlan?.task === "CODE_REVIEW" ||
  meta.reasoning?.depthHint === "deep";

if (!relaxOutputConstraints) {
  switch (pressure) {
    case "ASSERTIVE":
      meta.responseHint = {
        structure: "direct_answer",
        expansion: "guided",
        forbid: {
          narration: true,
          metaComment: true,
        },
      };
      meta.outputTransformHint = "SOFT_EXPAND";
      break;

    case "GENTLE":
      meta.responseHint = {
        expansion: "soft",
        forbid: {
          reasoning: true,
        },
      };
      meta.outputTransformHint = "SOFT_EXPAND";
      break;
  }
}

    /* -------------------------------------------------- */
    /* 7️⃣ Prompt Runtime                                 */
    /* -------------------------------------------------- */

        // 2) Permission (Judgment 이후)
    // - verdict 정보가 없으면 안전 기본값으로 고정 (personalization OFF)
    let personaContext: PersonaContext = defaultPersonaContext("anonymous_user");

    const verdictMaybe = (meta as any)?.verdict as
      | "APPROVE"
      | "BLOCK"
      | "DEFER"
      | "HOLD"
      | undefined;

    if (typeof verdictMaybe === "string") {
      try {
if (!meta.instanceId || !meta.userId) {
  console.warn("[PERSONA_CONTEXT][SKIPPED]", {
    reason: "missing workspace context",
    instanceId: meta.instanceId,
    userId: meta.userId,
  });
  // 🔒 개인화 스킵, personaContext는 default 유지
} else {
  const permission = await PersonaPermissionEngine.resolve({
    userId: Number(meta.userId),
    workspaceId: meta.instanceId, // ✅ 여기서 string 확정
    verdict: verdictMaybe,
    persona: personaHint.persona,
  });

  personaContext = {
    permission,
    behavior: aggregatedPersona
      ? {
          persona: aggregatedPersona.persona,
          confidence: aggregatedPersona.confidence,
          source: "history",
          meta: { samples: aggregatedPersona.samples },
        }
      : {
          persona: personaHint.persona,
          confidence: personaHint.confidence,
          source: "anchors",
        },
    version: "v1",
  };

  // 🔒 judgment 차단 소스일 때만 이름 호출 금지
  if (personaContext.permission.source === "judgment_blocked") {
    personaContext.permission.allowNameCall = false;
  }
}
      } catch (e) {
        // 실패해도 서비스 진행은 계속 (SSOT: 개인화는 best-effort)
        console.warn("[PERSONA_CONTEXT][RESOLVE_FAIL]", e);
      }
    }

    // 🪪 USER PROFILE (static, user-owned) — separate from personaContext.
    //
    // Read from user_prefs JSONB (nickname / jobRole / personalization)
    // PLUS the already-resolved personaContext.permission.displayName
    // (which sourced from workspace_user_tone_signal). All four fields
    // compose into a UserProfile that prompt-runtime renders as the
    // `<user_profile>` XML block. Every field is best-effort — any
    // failure downgrades to `undefined` and the block is omitted.
    //
    // Why here (not inside PersonaPermissionEngine): persona permission
    // is a "inferred behavior + name-call allowed" concern. Static
    // profile is user-owned settings. Different trust/write path.
    let userProfileForPrompt:
      | import("../persona/user-profile.types").UserProfile
      | undefined;
    try {
      if (meta.userId) {
        // 🔥 FIX Bug 5: _userPrefsResult from Mega Group A — no duplicate DB call
        const prefs = _userPrefsResult ?? (await import("../../db/repo/user-prefs.repo.js").then(m => m.getUserPrefs(Number(meta.userId))));
        userProfileForPrompt = {
          displayName: personaContext.permission.displayName ?? null,
          preferredName:
            typeof prefs?.nickname === "string" && prefs.nickname.trim()
              ? prefs.nickname.trim()
              : null,
          jobRole:
            typeof prefs?.jobRole === "string" && prefs.jobRole.trim()
              ? (prefs.jobRole.trim() as any)
              : null,
          customInstructions:
            typeof prefs?.personalization === "string"
              ? prefs.personalization
              : null,
        };
      }
    } catch (e) {
      console.warn("[USER_PROFILE][READ_FAIL]", e);
      userProfileForPrompt = undefined;
    }

    if (typeof verdictMaybe !== "string") {
      // verdict 없음: behavior만 넣을지 여부는 정책인데,
      // 안전하게 permission OFF 상태 유지 (behavior도 optional)
      personaContext = {
        ...personaContext,
        behavior: {
          persona: personaHint.persona,
          confidence: personaHint.confidence,
          source: "anchors",
        },
      };
    }

        // ✅ PromptRuntime로 넘길 reasoning에 __internal 주입 (타입 안전)
    const promptReasoning = meta.reasoning;
    
    console.log("[DEBUG][CHAT_ENGINE→PROMPT_RUNTIME_PAYLOAD]", {
      threadId: meta.threadId,
      turnIntent: meta.turnIntent,
      memoryContextLength: context.memoryContext?.length ?? 0,
      hasPersonaDisplayName:
        typeof personaContext.permission.displayName === "string" &&
        personaContext.permission.displayName.trim().length > 0,
    });


    const _prStart = Date.now();
    const runtimeResult = await runPromptRuntime({
  personaRole: persona.role,
  message,
  mode,
  thinkingProfile: meta.thinkingProfile, // 🔥 ADD (SSOT)
   threadId: meta.threadId,
   traceId: meta.traceId,
   stream: meta.stream,
   styleHint: buildStyleHint(styleProfile),
   turnIndex: meta.turnIndex, // ✅ PromptRuntime/Builder가 "첫턴" 판별 가능해야 함
  meta: {
    responseDensityHint: meta.responseDensityHint,
    conversationTurns,
    // 🔒 SSOT: PromptRuntime은 turnIntent를 반드시 안다
    turnIntent: meta.turnIntent,
    reasoning: promptReasoning,
    designHints: meta.designHints,
    failureSurface: failureSurface,
    signals,
    leadHint: meta.leadHint, // 🔥 SSOT: 설계 리드 힌트 전달
    outputTransformHint: meta.outputTransformHint,
    executionPlan,
    executionResult,
    anchorConfidence: context.anchorConfidence,
    continuityAllowed: context.continuityAllowed,
    contextCarryLevel: context.contextCarryLevel,
    personaPermission: {
      ...personaContext.permission,
    },
    responseHint: meta.responseHint,
    attachments: meta.attachments?.map((a) => ({
      kind: a.kind,
      fileName: (a as any).fileName,
      mimeType: a.mimeType,
      sizeBytes: (a as any).sizeBytes,
      // ✅ BUGFIX: PromptRuntime/PromptBuilder가 attachments를 살리려면 url이 필요
      url: (a as any).url,
    })),

    // 🪄 userId — REQUIRED for skills + memory-md injection. Without
    // this, prompt-runtime reads `undefined` and silently skips the
    // <skills> and <user_memories> blocks — the model never sees the
    // user's enabled skills or saved memory. This threading is the
    // single SSOT for per-user prompt context.
    userId: meta.userId != null ? Number(meta.userId) : undefined,
    fileRag: meta.fileRag,
    fileSessionId: meta.fileSessionId,
    workspaceId: meta.workspaceId,
    fileSignals: meta.fileSignals,
    fileRagForceOnce: meta.fileRagForceOnce,

    // ✅ PromptBuilder에 필요한 것만
    referenceContext: [context.memoryContext, toolRuntimeContext].filter(Boolean).join("\n\n"),
    trustedFacts: toolFacts,
    constraints: context.constraints,
    outmode: meta.outmode,

    // 🌐 UI locale (from NEXT_LOCALE cookie, threaded through meta). When
    // present, prompt-runtime's language-constraint resolver prefers it
    // over the detected chat-message language.
    uiLocale: (meta as any).uiLocale ?? null,

    // Slash-command selected skill slug → prompt-runtime pins it first
    skillSlug: meta.skillSlug,

    // 🪪 Static user profile block (from user_prefs + tone_signal).
    // Prompt-runtime renders it to `<user_profile>` XML and prepends
    // to the reference context slot. Undefined → block omitted.
    userProfile: userProfileForPrompt,
  },
});
 if (reasoningController) {
   reasoningController.beginStage("prompt_runtime");
   reasoningController.appendTrace({
     persona: persona.role,
     outmode: meta.outmode,
   });
   await reasoningController.completeStage();
 }
const prompt = runtimeResult.message;
if (runtimeResult.meta?.fileRagConfidence != null) {
  meta.fileRagConfidence = runtimeResult.meta.fileRagConfidence;
}

console.log("[PERF][PROMPT_RUNTIME]", { ms: Date.now() - _prStart });
console.log("[TRACE][CHAT_ENGINE_PROMPT_BUILT]", {
  type: typeof prompt,
  length: prompt?.length ?? 0,
});

    console.log("[DEBUG][OPENAI_RUNTIME_IN]", {
  mode,
  outmode: meta.outmode,
  stream: meta.stream,
  promptLength: prompt.length,
});

/* -------------------------------------------------- */
/* 🎨 STYLE PROFILE PERSIST (SSOT)                    */
/* -------------------------------------------------- */

if (
  meta.threadId &&
  !meta.stream &&
  styleProfile.samples <= 3
) {
  await saveThreadStyleProfile(
    meta.threadId,
    styleProfile,
    language
  );
}

/* -------------------------------------------------- */
/* NOTE: These memory blocks run for NON-STREAM only. */
/* Stream mode memory is handled by                    */
/* memory-pipeline-runner.ts via execution-engine.ts   */
/* stream end hook.                                    */
/* -------------------------------------------------- */

let memoryCandidate: MemoryCandidate | null = null;

/* -------------------------------------------------- */
/* 🧠 PHASE 9-3-IMPLICIT: Implicit Memory (NON-STREAM) */
/* -------------------------------------------------- */

if (
  !meta.stream &&
  policy.allowMemory === true &&
  !memoryCandidate &&
  meta.instanceId &&
  meta.userId
) {
  try {
    const { detectImplicitMemory } = await import("../memory/memory-implicit-detector.js");
    const { scoreImplicitCandidate } = await import("../memory/memory-implicit-scorer.js");
    const implicitResult = detectImplicitMemory(message);
    if (implicitResult.category !== "NONE") {
      const score = scoreImplicitCandidate(implicitResult, message);
      if (score >= 0.55) {
        memoryCandidate = {
          content: implicitResult.extractedContent,
          scope: implicitResult.scope,
          confidence: score,
          reason: `implicit_${implicitResult.category.toLowerCase()}`,
          source: "passive",
          meta: { origin: "language" },
        };
        meta.memoryCandidate = memoryCandidate;
      }
    }
  } catch (e) {
    console.warn("[IMPLICIT_MEMORY][ERROR]", e);
  }
}

/* -------------------------------------------------- */
/* 🧠 PHASE 9-3: Memory Candidate Generation (SSOT)   */
/* -------------------------------------------------- */

if (
  !meta.stream &&
  policy.allowMemory === true &&
  executionPlan &&                // ✅ 추가
  executionResult &&
  executionResult.ok === true
) {
    /**
   * 🔒 SSOT — DEEP MEMORY RULE
   * - DEEP mode라도
   * - execution 기반 결과만 memory 후보 허용
   * - 사고/설명 텍스트 기반 memory ❌
   */
  if (mode === "DEEP") {
    // execution 기반은 허용 (기존 로직 유지)
  }

  memoryCandidate = generateMemoryCandidate({
    userMessage: message,
    executionPlan,                 // 이제 타입 안전
    executionResult,
    reasoningConfidence: reasoning.confidence,
  });

  meta.memoryCandidate = memoryCandidate ?? undefined;

  // SSE: PENDING
  if (memoryCandidate && meta.threadId && meta.traceId) {
    try {
      await StreamEngine.publish(meta.threadId, buildMemoryStreamEvent({
        traceId: meta.traceId,
        op: "PENDING",
        scope: mapCandidateScopeToMemoryScope(memoryCandidate.scope, memoryCandidate.meta),
        content: memoryCandidate.content,
        confidence: memoryCandidate.confidence,
      }));
    } catch {}
  }
}

/* -------------------------------------------------- */
/* 🧠 PHASE 9-3-B: Language Decision Candidate (SSOT) */
/* -------------------------------------------------- */

if (
  !meta.stream &&
  policy.allowMemory === true &&
  !memoryCandidate && // ⬅ Execution 기반 후보 없을 때만
  reasoning.intent === "decide" &&
    reasoning.confidence >= 0.85 &&
  meta.turnIntent !== "CONTINUATION"
) {
  memoryCandidate = generateLanguageDecisionCandidate({
    answer: prompt,
    reasoning,
    confidence: reasoning.confidence,
    source: "language",
  });

  meta.memoryCandidate = memoryCandidate ?? undefined;

  // SSE: PENDING (language decision)
  if (memoryCandidate && meta.threadId && meta.traceId) {
    try {
      await StreamEngine.publish(meta.threadId, buildMemoryStreamEvent({
        traceId: meta.traceId,
        op: "PENDING",
        scope: mapCandidateScopeToMemoryScope(memoryCandidate.scope, memoryCandidate.meta),
        content: memoryCandidate.content,
        confidence: memoryCandidate.confidence,
      }));
    } catch {}
  }
}

/* -------------------------------------------------- */
/* 🧠 USER_LONGTERM AUTO COMMIT (SSOT STRICT)         */
/* -------------------------------------------------- */

if (
  !meta.stream &&
  meta.memoryIntent === "REMEMBER" &&
  meta.instanceId &&
  meta.userId
) {
  const summary = message.trim().slice(0, 300);

  try {
    await CrossMemoryWriter.insert({
      workspaceId: meta.instanceId,
      userId: Number(meta.userId),
      type: "USER_LONGTERM",
      summary,
      scope: "GLOBAL",
      sourceThreadId: meta.threadId,
    });

    meta.memoryCommitted = true;

    console.log("[USER_LONGTERM][COMMITTED]", {
      workspaceId: meta.instanceId,
      userId: meta.userId,
      summaryPreview: summary.slice(0, 60),
    });
  } catch (e) {
    console.error("[USER_LONGTERM][ERROR]", e);
  }
}


/* -------------------------------------------------- */
/* 🧠 PHASE 9-4: Memory Auto Commit (SSOT)             */
/* -------------------------------------------------- */

let dedupResult: any = null;
if (
  !meta.stream &&
  memoryCandidate &&
  meta.instanceId &&
  meta.userId
) {
   /* -------------------------------------------------- */
  /* 🧠 PHASE 9-3-C: Memory Dedup (SSOT)                */
  /* -------------------------------------------------- */

  try {
    const existingMemories =
      await MemoryManager.retrieveByScope({
        workspaceId: meta.instanceId,
        scope: mapCandidateScopeToMemoryScope(
          memoryCandidate.scope,
          memoryCandidate.meta
        ),
        limit: 12,
      });

    dedupResult = await dedupMemoryCandidate({
      candidate: memoryCandidate,
      existingContents: existingMemories.map(
        (m) => m.content
      ),
    });

    if (dedupResult.isDuplicate) {
      console.log("[MEMORY_DEDUP][SKIPPED]", {
        reason: dedupResult.reason,
        similarity: dedupResult.similarity,
        scope: memoryCandidate.scope,
      });

      // SSE: SKIPPED (dedup)
      if (meta.threadId && meta.traceId) {
        try {
          await StreamEngine.publish(meta.threadId, buildMemoryStreamEvent({
            traceId: meta.traceId,
            op: "SKIPPED",
            scope: mapCandidateScopeToMemoryScope(memoryCandidate.scope, memoryCandidate.meta),
            content: memoryCandidate.content,
            reason: dedupResult.reason ?? "duplicate",
          }));
        } catch {}
      }

      // 🔥 FIX Bug 4: 조기 return 대신 플래그 — safety/learning 블록은 항상 통과
    }
  } catch (e) {
    // 🔒 best-effort: Dedup 실패는 저장을 막지 않음
    console.warn("[MEMORY_DEDUP][ERROR]", e);
  }
  const memoryCommitSkipped = dedupResult?.isDuplicate === true;
  // 🔒 SSOT: Generate AnswerState from prompt so memory guard can evaluate
  const memoryAnswerState = !memoryCommitSkipped && prompt
    ? AnswerStateAnalyzer.analyze(prompt, { mode: mode as any })
    : undefined;

  // 🔥 FIX Bug 4: dedup 시 memory commit만 스킵, safety/learning은 아래서 항상 실행
  const decision = memoryCommitSkipped ? { shouldCommit: false, reason: "dedup_skipped" } : await shouldAutoCommitMemory(
    meta.instanceId,
    memoryCandidate,
    memoryAnswerState
  );

  if (decision.shouldCommit) {
    await MemoryManager.commit({
      workspaceId: meta.instanceId,
      createdByUserId: Number(meta.userId),
      scope: mapCandidateScopeToMemoryScope(
      memoryCandidate.scope,
      memoryCandidate.meta
      ),
      content: memoryCandidate.content,
      confidence:
        decision.meta?.confidence ?? memoryCandidate.confidence,
      source: memoryCandidate.source,
      threadId: meta.threadId,
      traceId: meta.traceId,
    });

    console.log("[MEMORY_AUTO_COMMIT][SUCCESS]", {
      scope: memoryCandidate.scope,
      confidence: memoryCandidate.confidence,
      source: memoryCandidate.source,
    });

    // SSE: SAVED
    if (meta.threadId && meta.traceId) {
      try {
        await StreamEngine.publish(meta.threadId, buildMemoryStreamEvent({
          traceId: meta.traceId,
          op: "SAVED",
          scope: mapCandidateScopeToMemoryScope(memoryCandidate.scope, memoryCandidate.meta),
          content: memoryCandidate.content,
          confidence: decision.meta?.confidence ?? memoryCandidate.confidence,
        }));
      } catch {}
    }
  } else {
    console.log(
      "[MEMORY_AUTO_COMMIT][SKIPPED]",
      decision.reason
    );

    // SSE: SKIPPED (policy)
    if (meta.threadId && meta.traceId) {
      try {
        await StreamEngine.publish(meta.threadId, buildMemoryStreamEvent({
          traceId: meta.traceId,
          op: "SKIPPED",
          scope: mapCandidateScopeToMemoryScope(memoryCandidate.scope, memoryCandidate.meta),
          content: memoryCandidate.content,
          reason: decision.reason ?? "policy_rejected",
        }));
      } catch {}
    }
  }
}



// 🔒 STREAM MODE: Self-learning MUST NOT run
 if (!meta.stream) {
    const violation = checkClaimBoundaryViolation({
    text: prompt,
    boundary: claimBoundary,
  });

  if (violation.violated) {
    await judgmentFailureStore.addHardFailure({
      instanceId: meta.instanceId ?? "default-instance",
      input: message,
      originalPath: path,
      reason: `CLAIM_BOUNDARY_VIOLATION: ${violation.reason}`,
      stage: "generation",
    });
  }

   judgmentLearningLoop.maybeRun({
     stream: false,
   });
 }

 if (meta.stream) {
   Object.freeze(meta);
 }


return {
  ok: true,
  engine: "chat",
  persona: persona.role,
  mode,
  path,
  prompt,
  meta,
};

} catch (err) {
 console.error("[CHAT_ENGINE_FATAL]", {
   messageLength: typeof message === "string" ? message.length : 0,
   persona,
   traceId: meta?.traceId,
   error: err instanceof Error ? err.stack : err,
 });
    throw err;
  }

  },  

    /**
   * 🔒 SSOT WRAPPER
   * - DecisionContext가 지능의 단일 진실 원본
   * - ChatEngine은 컴파일러 역할만 수행
   * - Reasoning / Path / Persona 재계산 ❌
   */
  async generateFromDecision(
    decisionCtx: DecisionContext,
    meta: ChatMeta = {}
  ): Promise<ChatEngineResult> {
   // 🔥 SSOT: attachments 존재 시 이미지 분석 단계 선행 표시
    const attachments =
      (decisionCtx as any).attachments ??
      meta.attachments;

const prevTurnContinuity = {
  anchorConfidence: decisionCtx.anchorConfidence,
  continuityAllowed:
    decisionCtx.anchorConfidence >= 0.4 &&
    decisionCtx.turnIntent !== "SHIFT",
  contextCarryLevel:
    decisionCtx.anchorConfidence >= 0.6
      ? "SEMANTIC"
      : "ENTITY",
} as const;

  // SSOT: turnIntent is 결정 단계 단일 진실 원본
  const refinedTurnIntent = decisionCtx.turnIntent;

    const result = await this.generateResponse(
      decisionCtx.sanitizedMessage,
      {
        role:
          decisionCtx.personaContext?.behavior?.persona ??
          "unknown",
      },
      {
        ...meta,
        failureSurface: decisionCtx.failureSurface,
        thinkingProfile: decisionCtx.thinkingProfile, // 🔥 SSOT HARD BIND
        computePolicy: decisionCtx.computePolicy, 
       responseAffordance: decisionCtx.responseAffordance,
        prevResponseAffordance:
          decisionCtx.prevResponseAffordance,
          conversationalOutcome: decisionCtx.conversationalOutcome,
          prevTurnContinuity,
         threadId: decisionCtx.threadId,
         attachments,
      userId: decisionCtx.userId,
      instanceId: decisionCtx.instanceId,
      traceId: decisionCtx.traceId,
      decisionPath: decisionCtx.path,
      mode: decisionCtx.mode,        // 🔥 핵심
      turnFlow: decisionCtx.turnFlow, // 🔥 추가
      verdict:
        decisionCtx.decision.verdict === "REJECT"
          ? "HOLD"
          : decisionCtx.decision.verdict,
      memoryIntent: decisionCtx.memoryIntent as ChatMeta["memoryIntent"],
      toolGate: decisionCtx.toolGate,
      visionBudget: decisionCtx.toolGate?.visionBudget,
       turnIntent: refinedTurnIntent,   // 🔥 여기
      executionPlan: decisionCtx.executionPlan ?? meta.executionPlan,
      executionResult: meta.executionResult,
               reasoning: decisionCtx.reasoning,   // 🔒 그대로
      fileSignals: decisionCtx.fileSignals,
      fileRagForceOnce: decisionCtx.fileRagForceOnce,

    }
  );

    if (
      result.ok === true &&
      result.meta?.fileRagConfidence != null
    ) {
      decisionCtx.fileRagConfidence =
        result.meta.fileRagConfidence;
    }
    return result;
},

  // 🔒 SSOT: DONE 이후에만 호출됨
  async emitSuggestions(args: {
    threadId: number;
    traceId: string;
    reasoning: NonNullable<ChatMeta["reasoning"]>;
    attachments?: AttachmentMeta[];
    verdict?: "APPROVE" | "HOLD";
    responseAffordance?: ResponseAffordanceVector;
    prevResponseAffordance?: ResponseAffordanceVector;
    mode?: "FAST" | "NORMAL" | "DEEP" | "SEARCH";
    turnIntent?: TurnIntent;
    signalHints?: SignalHints;
  }) {

      // 🔒 SSOT: FAST mode never emits suggestions
    if (args.mode === "FAST") {
      return;
    }

 // 🔒 HARD GUARD 0: reasoning 필수
 if (!args.reasoning) {
   console.warn("[SUGGESTION][SKIP]", {
     reason: "MISSING_REASONING",
     threadId: args.threadId,
   });
   return;
 }
    
       console.log("[SUGGESTION][ENTER]", {
   threadId: args.threadId,
   affordance: args.responseAffordance,
   hasReasoning: Boolean(args.reasoning),
   verdict: args.verdict,
 });

 const isMultimodal =
   Array.isArray((args as any).attachments) &&
   (args as any).attachments.length > 0;

  if (isMultimodal) {
    console.log("[SUGGESTION][SKIP]", {
      reason: "MULTIMODAL_FIRST_TURN",
      threadId: args.threadId,
    });
    return;
  }

  // 🔒 SSOT: AnswerBuffer에서 최종 텍스트 회수
  const finalText = AnswerBuffer.consume(args.threadId);

  // 응답이 없으면 종료
  if (!finalText || finalText.trim().length === 0) {
    return;
  }

  // 🔒 SSOT: AnswerState는 단 한 번만 생성
  const answerState = AnswerStateAnalyzer.analyze(finalText);

  // 🔒 SSOT: COMPLETE 판단은 여기서만
  if (answerState.completeness === "FULL") {
    return;
  }
  const isVisionResponse =
    args.reasoning?.domain === "etc" &&
    args.reasoning?.intent === "ask" &&
    args.reasoning?.depthHint === "shallow";

  if (
    !isVisionResponse &&
    (!finalText || finalText.trim().length < 30)
  ) {
    console.log("[SUGGESTION][SKIP]", {
      reason: "ANSWER_TOO_SHORT",
      threadId: args.threadId,
    });
    return;
  }


 const strategy = ConversationStrategyEngine.decide({
   reasoning: args.reasoning,
   answerState,
   affordance: args.responseAffordance,
   prevAffordance: args.prevResponseAffordance,
   turnIntent: normalizeTurnIntentForStrategy(args.turnIntent),
   isStreaming: false,
 });

 if (!strategy.showSuggestions) return;
 

       const raw =
   ContinuationSuggestionEngine.generate(
     args.reasoning,
     answerState,
     args.signalHints
   );
  const suggestions = raw
    .slice(0, strategy.maxSuggestions)
    .map((s) => ({
      id: s.id,
      label: s.label,
      action: s.action ?? "REQUEST_INFO", // 🔒 SSOT default
      priority: s.priority ?? "NORMAL",
    }));

        await StreamEngine.publish(args.threadId, {
   event: "stage",
   stage: StreamStage.SUGGESTION,
   traceId: args.traceId,
 });

        await StreamEngine.publish(args.threadId, {
    event: "suggestion",
    stage: StreamStage.SUGGESTION,
    traceId: args.traceId,
    suggestion: {
    items: suggestions,
  },
  });


      console.log("[SUGGESTION][PUBLISHED]", {
    threadId: args.threadId,
    traceId: args.traceId,
    count: suggestions.length,
    items: suggestions.map((s: YuaSuggestion) => ({
      id: s.id,
      // ⚠️ 타입 안정성 유지: 구조만 확인
      keys: Object.keys(s as any),
    })),
  });

    await FlowLogRepo.insert({
      threadId: args.threadId,
      traceId: args.traceId,
      intent: args.reasoning.intent,
      userStage: args.reasoning.userStage,
      confidence: args.reasoning.confidence,
      suggestions,
      meta: { engine: "continuation" },
    });

    return suggestions;
  },
};
