// 🔥 YUA Prompt Runtime — STABLE CORE (2026.01)
// --------------------------------------------------
// ✔ Prompt 생성 ❌
// ✔ Decision 결과 소비 ONLY
// ✔ 메타 정리 + PromptBuilder로 위임
// --------------------------------------------------

import type { ChatMode } from "../types/chat-mode";
import { OUTMODE } from "../types/outmode";
import type { PersonaContext } from "../../persona/persona-context.types";
import type { FlowAnchor } from "../../reasoning/reasoning-engine";
import type { ExecutionPlan } from "../../execution/execution-plan";
import type { ExecutionResult } from "../../execution/execution-result";
import { sanitizeContent } from "../../utils/sanitizer";
import type { TurnIntent } from "../types/turn-intent";
import type { TopicShift } from "../../decision/topic-shift-detector";
import { PromptBuilder } from "../../utils/prompt-builder";
import { PromptBuilderDeep } from "../../utils/prompt-builder-deep";
import { estimateTokens } from "../../../utils/tokenizer";
import type { ISO639_1 } from "../../style/detector.interface";
import { resolveLanguageConstraint } from "../../i18n/language-constraints";
import {
  renderUserProfileBlock,
  type UserProfile,
} from "../../persona/user-profile.types";
import { renderSkillsBlock } from "../../../skills/skill-injector";
import { listInstalledSkills } from "../../../skills/skills-registry";
import { retrieveTopSkills } from "../../../skills/skill-retrieval";
import type { ResponseHint } from "../types/response.final";
import type { FailureSurface } from "../../selfcheck/failure-surface-engine";
import type { ThinkingProfile }
  from "yua-shared/types/thinkingProfile";
  import { StructuredCodeIngest } from "../../code-ingest/structured-code-ingest";
import type { DbClient } from "../../file-intel/vector/db";
import type { Embedder as FileEmbedder } from "../../file-intel/vector/embedder";
import { pgPool as _pgPool } from "../../../db/postgres";
import { listActiveConnectors as _listActiveConnectors } from "../../../connectors/oauth/token-store";
/* -------------------------------------------------- */
/* Prompt Runtime Result                               */
/* -------------------------------------------------- */
export interface PromptRuntimeResult {
  message: string;
  meta: {
    memoryContext?: string;
     referenceContext?: string;
    trustedFacts?: string;
    constraints?: string[];
    uiThinkingAllowed?: boolean;
    fileRagConfidence?: number;
    personaPermission?: {
  allowNameCall: boolean;
  allowPersonalTone: boolean;
  displayName?: string | null;
};
    reasoning?: PromptRuntimeMeta["reasoning"];
    outmode?: OUTMODE;
  };
}

/* -------------------------------------------------- */
/* Prompt Runtime Meta (SSOT SAFE)                     */
/* -------------------------------------------------- */
export interface PromptRuntimeMeta {
    conversationTurns?: {
    role: "user" | "assistant" | "system";
    content: string;
  }[];

  /**
   * 🔥 Design Observations (SSOT)
   * - Reference only
   * - MUST NOT be treated as instruction or constraint
   */
  designHints?: {
    stage: string;
    observations: string[];
    confidence: number;
  }[];
   // 🔥 SSOT: Multimodal hint (READ-ONLY)
  // - PromptRuntime에서 Vision framing 용도로만 사용
  // - 판단 / Decision / Memory 영향 ❌
  attachments?: {
    kind: "image" | "audio" | "video" | "file";
    fileName?: string;
    mimeType?: string;
    sizeBytes?: number;
    url?: string;
  }[];
  memoryContext?: string;
  referenceContext?: string;
  trustedFacts?: import("../../tools/tool-runner").TrustedFactHint[];
  signals?: import("../../signals/yua-signal.types").YuaSignal[];
  toneBias?: import("../../decision/decision-context.types").DecisionContext["toneBias"];
  constraints?: string[];
    // 🔥 Continuity (from ContextRuntime)
  anchorConfidence?: number;
  continuityAllowed?: boolean;
  contextCarryLevel?: "RAW" | "SEMANTIC" | "ENTITY";
  responseDensityHint?: import("../types/response-density").ResponseDensityHint;
  conversationalOutcome?: import("../../decision/conversational-outcome").ConversationalOutcome;
  outputTransformHint?: 
   | "DELTA_ONLY"
   | "ROTATE"
   | "SUMMARIZE"
   | "CONCLUDE"
   | "SOFT_EXPAND";

    // 🔥 SSOT: Response Mode (controls output structure, not tone)
  responseMode?: {
  mode: "ANSWER" | "CONTINUE" | "CLARIFY";
  forbidQuestion?: boolean;
    forbid?: {
      intro?: boolean;
      domainDefinition?: boolean;
      backgroundExplanation?: boolean;
      reSummary?: boolean;
    };
  };

    // 🔥 Response Density Hint (NON-BINDING)
  // - 말의 밀도에 대한 참고 신호
  // - enforcement 금지
  responseHint?: ResponseHint;
  leadHint?: import("../types/lead-hint").LeadHint; // 🔥 READ-ONLY
  explanationRequested?: boolean;
  failureSurface?: FailureSurface;
  turnIntent?: TurnIntent;
  topicShift?: TopicShift;

  reasoning?: {
    stage?: "clarifying" | "explaining" | "solving" | "closing";
    depthHint: "shallow" | "normal" | "deep";
    cognitiveLoad: "low" | "medium" | "high";
    nextAnchors: FlowAnchor[];
    confidence?: number;
  };

  executionPlan?: ExecutionPlan;
  executionResult?: ExecutionResult;
  /**
   * User id (MySQL SSOT). Required for skills + memory-md injection —
   * every chat pre-flight reads enabled skills / memory markdown from
   * the DB, scoped to this user. Undefined = inject nothing (skills and
   * memory-md blocks are skipped).
   */
  userId?: number;
  threadId?: number;
  workspaceId?: string;
  fileSessionId?: string;
  fileRag?: {
    db: DbClient;
    embedder: FileEmbedder;
    workspaceId: string;
  };
  fileSignals?: {
    hasFile: boolean;
    hasFileIntent: boolean;
    relevanceScore: number;
  };
  fileRagForceOnce?: boolean; // 🔥 ADD
  fileRagConfidence?: number;
  fileRagConflict?: boolean;

  /**
   * Slash-command selected skill slug.
   * When set, this skill is pinned to the front of preferredSlugs so it
   * always gets full body expansion in the skills block, regardless of
   * the pgvector retrieval result.
   */
  skillSlug?: string;

  personaPermission?: {
    allowNameCall: boolean;
    allowPersonalTone: boolean;
    displayName?: string | null;
  };

  /**
   * UI locale preference from the user's browser (NEXT_LOCALE cookie).
   * Overrides detected chat-message language for output-language
   * enforcement. Matches frontend `yua-web/src/i18n/config.ts` LOCALES.
   * Undefined = fall through to detected language.
   */
  uiLocale?: string | null;

  /**
   * User-owned static profile from Settings → General → Profile.
   *   - displayName / preferredName — naming preferences
   *   - jobRole — enum key mapped to English label before rendering
   *   - customInstructions — freeform sanitized text
   * Prompt-runtime renders this to a `<user_profile>` XML block and
   * prepends it to the reference context; the model sees it in the
   * system slot with an accompanying `<user_profile_policy>` block that
   * forbids echoing or over-applying it. Undefined / all-empty fields
   * → whole block omitted.
   */
  userProfile?: UserProfile | null;
  outmode?: OUTMODE;
}

/**
 * Thin shim around the SSOT resolver in `ai/i18n/language-constraints.ts`.
 *
 * Left as a function (not an inline import) to preserve the existing
 * call site at line ~424. Accepts BOTH the detected style-ISO code and
 * an explicit UI locale preference; the SSOT resolver prefers the UI
 * locale when present. See `language-constraints.ts` for the full matrix
 * (all 11 locales + region-code normalization).
 */
function buildLanguageConstraint(
  language?: ISO639_1,
  uiLocale?: string | null
): string | undefined {
  if ((!language || language === "unknown") && !uiLocale) return undefined;
  return resolveLanguageConstraint({
    uiLocale: uiLocale ?? null,
    detectedLanguage: language ?? null,
  });
}

// 16_000 tokens (~64KB) — enough for the compact skills block + memory
// MD + reference context + user profile stack. The skills block itself
// now compacts rather than truncates (see skill-injector.ts Phase D.7),
// so we don't need to balloon this cap. If reference still overflows,
// the compactor degrades gracefully skill-by-skill rather than chopping
// mid-body.
const HARD_REF_TOKEN_CAP = 16_000;

function trimByTokenBudget(text: string, maxTokens: number): string {
  if (!text) return "";
  const tokens = estimateTokens(text);
  if (tokens <= maxTokens) return text;

  // Prioritize tail (newest context) 70% over head (oldest) 30%
  const headTokenBudget = Math.floor(maxTokens * 0.3);
  const tailTokenBudget = maxTokens - headTokenBudget;

  // Use conservative 2 chars/token for mixed Korean/English
  let headEnd = Math.min(text.length, headTokenBudget * 2);
  while (headEnd > 0 && estimateTokens(text.slice(0, headEnd)) > headTokenBudget) {
    headEnd = Math.floor(headEnd * 0.8);
  }

  let tailStart = Math.max(0, text.length - tailTokenBudget * 2);
  while (tailStart < text.length && estimateTokens(text.slice(tailStart)) > tailTokenBudget) {
    tailStart = Math.floor(tailStart + (text.length - tailStart) * 0.2);
  }

  const head = text.slice(0, headEnd);
  const tail = text.slice(tailStart);
  return head + "\n\n(...middle context truncated...)\n\n" + tail;
}

/**
 * Sanitize external data before embedding in system prompt.
 * Strips potential prompt injection patterns.
 */
function stripInjectionPatterns(text: string): string {
  return text
    // Strip common injection patterns
    .replace(/\[(?:SYSTEM|INSTRUCTION|RULE|IMPORTANT|OVERRIDE|IGNORE)[^\]]*\]/gi, "[REDACTED]")
    .replace(/(?:ignore|disregard|forget)\s+(?:above|previous|all)\s+(?:instructions?|rules?|prompts?)/gi, "[REDACTED]")
    .replace(/you\s+are\s+now\b/gi, "[REDACTED]")
    .replace(/(?:^|\n)\s*(?:system|developer|admin)\s*:/gi, "\n[REDACTED]:")
    // Model-specific control tokens
    .replace(/\[INST\]/gi, "[REDACTED]")
    .replace(/<\|(?:im_start|im_end|system|endoftext)\|>/gi, "[REDACTED]")
    .replace(/<<\s*SYS\s*>>/gi, "[REDACTED]");
}

export function sanitizeToolOutput(raw: unknown): string {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
  return stripInjectionPatterns(text).slice(0, 2000);
}

export function sanitizeExternalBlock(raw: unknown, maxLen = 2500): string {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
  const cleaned = stripInjectionPatterns(text).slice(0, maxLen);
  return `<external_data>\n${cleaned}\n</external_data>`;
}

function renderTrustedFacts(
  facts?: import("../../tools/tool-runner").TrustedFactHint[]
): string[] | undefined {
  if (!facts || facts.length === 0) return undefined;

  return facts.map(f => {
    switch (f.kind) {
      case "MARKET_SERIES":
        return `시장 데이터 (${sanitizeToolOutput(f.market)} ${sanitizeToolOutput(f.symbol)})
- 기간: ${sanitizeToolOutput(f.coverage.start)} ~ ${sanitizeToolOutput(f.coverage.end)}
- 최신 OHLCV: ${sanitizeToolOutput(f.latest?.fields)}`;
      default:
        return "";
    }
  }).filter(Boolean);
}

function renderSignals(
  signals?: import("../../signals/yua-signal.types").YuaSignal[]
): string | undefined {
  if (!signals || signals.length === 0) return undefined;

  const eventSignals = signals.filter(
    s => s.origin === "EventMarketSolver"
  );

  if (!eventSignals.length) return undefined;

  return (
    "[MARKET EVENT SIGNAL]\n" +
    eventSignals
      .map(
        s =>
          `- value=${s.value}, confidence=${s.confidence}`
      )
      .join("\n")
  );
}




/* -------------------------------------------------- */
/* Prompt Runtime                                     */
/* -------------------------------------------------- */
export async function runPromptRuntime(args: {
  personaRole: string;
  message: string;
  mode: ChatMode;
  thinkingProfile?: ThinkingProfile; // 🔥 ADD
  meta: PromptRuntimeMeta;
  styleProfile?: never;
  styleHint?: string;
  turnIndex?: number;
  language?: ISO639_1; 
  threadId?: number;      // ✅ (옵션) 여기서 바로 받을 수 있으면 베스트
  traceId?: string;
  stream?: boolean;
}): Promise<PromptRuntimeResult> {
  const _perfStart = Date.now();
  const sanitizedMessage = sanitizeContent(args.message);
 // 🔥 LARGE CODE SAFE INGEST
 const structured = StructuredCodeIngest.run({
   message: sanitizedMessage,
 });

 const finalUserMessage =
   structured?.focusPrompt ?? sanitizedMessage;
  const { meta } = args;
const hasText = sanitizedMessage.trim().length > 0;


    // 🔥 SSOT: Vision signal (HINT ONLY, no control)
 const hasImage =
   Array.isArray(meta.attachments) &&
   meta.attachments.some(
     a => a.kind === "image" && typeof (a as any).url === "string"
   );
     /* -------------------------------------------------- */
  /* 🔥 Vision Response Mode Split (SSOT)              */
  /* - IMAGE_ANALYSIS라도 항상 분석형으로 가지 않음   */
  /* - 자연 대화형 Vision 허용                         */
  /* -------------------------------------------------- */

  const isVisionTask =
    meta.executionPlan?.task === "IMAGE_ANALYSIS";

  const conversationalVision =
    isVisionTask &&
    meta.turnIntent === "QUESTION" &&
    meta.reasoning?.depthHint !== "deep";

  if (conversationalVision) {
    meta.constraints = [
      ...(meta.constraints ?? []),
      "이미지에 대해 사람이 대화하듯 자연스럽게 반응하라.",
      "보고서형 분석 구조(항목 나열, 구조화된 관찰 목록)는 피하라.",
      "불필요하게 세부 분석으로 과도하게 확장하지 말 것.",
    ];
  }

      // 🔒 SSOT: PromptBuilder로 전달 가능한 attachment만 선별
  // - image | file 만 허용
  // - fileName + url 있는 경우만
  const builderAttachments =
    Array.isArray(meta.attachments)
      ? meta.attachments
          .map((a) => {
            const url = (a as any).url;
            if (a.kind === "image") {
              // ✅ image는 fileName 없을 수도 있으니 허용 (PromptBuilder는 image에 fileName을 강제하지 않아도 됨)
              return typeof url === "string"
                ? {
                    kind: "image" as const,
                    fileName: (a as any).fileName ?? "image",
                    mimeType: a.mimeType,
                    sizeBytes: (a as any).sizeBytes,
                    url,
                  }
                : null;
            }
            if (a.kind === "file") {
              const fileName = (a as any).fileName;
              return typeof url === "string" && typeof fileName === "string"
                ? {
                    kind: "file" as const,
                    fileName,
                    mimeType: a.mimeType,
                    sizeBytes: (a as any).sizeBytes,
                    url,
                  }
                : null;
            }
            return null;
          })
          .filter(Boolean) as {
          kind: "image" | "file";
          fileName: string;
          mimeType?: string;
          sizeBytes?: number;
          url: string;
        }[]
      : undefined;

  const fileRagMeta = {
    fileRag: meta.fileRag,
    fileSessionId: meta.fileSessionId,
    threadId: args.threadId ?? meta.threadId,
    workspaceId: meta.workspaceId ?? meta.fileRag?.workspaceId,
    fileSignals: meta.fileSignals,
    fileRagForceOnce: meta.fileRagForceOnce,
  };

 // ✅ Guard: 이미지 생성 요청인데 attachments가 없으면
  // - "외부 이미지 URL을 답변으로 출력" 금지
  // - "JSON만 던지고 끝" 금지
  // - 대신 "Execution 결과를 기다리는 안내" 정도의 자연어만 허용
  //   (실제로는 ChatEngine에서 Execution으로 보내는 게 정답)
  if (!hasImage) {
    meta.constraints = [
      ...(meta.constraints ?? []),
      "이미지 생성 결과를 외부 URL 링크로 직접 제공하지 말 것.",
      "JSON 객체만 단독으로 출력하지 말 것.",
      "사용자에게는 자연어로 짧게 안내하고, 실제 이미지는 시스템의 생성 파이프라인 결과로 제공할 것.",
    ];
  }

 // 🔒 SSOT: ExecutionResult narrowing
  const evidenceSignals =
    meta.executionResult?.ok === true
      ? meta.executionResult.evidenceSignals
      : undefined;

   // 🔒 SSOT: CLARIFY는 "첫 턴 + 진짜 애매"에서만 허용해야 함.
  // PromptRuntime는 강제하지 않고, Builder에게 정책 힌트로만 전달한다.
  // (실제 ambiguous 판별은 Decision 단계가 더 맞지만, 최소 방어)
  const isFirstTurn = (args.turnIndex ?? 0) < 1;
  const looksAmbiguous =
    hasText &&
    sanitizedMessage.length <= 18 &&
    !/[?.!]|(왜|어떻게|뭐|무엇|어떤|which|what|why|how)/i.test(sanitizedMessage);
  if (!isFirstTurn && meta.responseMode?.mode === "CLARIFY") {
    meta.responseMode = { mode: "ANSWER" };
  }
  if (!meta.responseMode && isFirstTurn && looksAmbiguous) {
    meta.responseMode = { mode: "CLARIFY" };
  }

   // 🔒 SSOT: Output Language Enforcement (Constraint-level)
  //
  // Priority: explicit UI locale (from user settings / NEXT_LOCALE cookie)
  // wins over detected chat-message language. This lets a Japanese-UI user
  // keep getting Japanese replies even if they paste in an English snippet.
  // If neither is present, no constraint is injected.
  const languageConstraint = buildLanguageConstraint(
    args.language,
    meta.uiLocale ?? null
  );

 const effectiveConstraints = languageConstraint
   ? [...(meta.constraints ?? []), languageConstraint]
   : meta.constraints;

   // 🪪 SSOT: User Profile Injection
   //
   // Render the user-owned `<user_profile>` + `<user_profile_policy>`
   // block. We prepend to the resolved reference text so PromptBuilder
   // places it in the system slot above memory / trusted facts — so the
   // `<user_profile>` hierarchy sits above `<user_memories>`.
   //
   // Important: we have to resolve the SAME reference fallback chain
   // the downstream `rawReference` uses (referenceContext →
   // memoryContext → ""), otherwise a profile-present path would
   // silently drop memoryContext when referenceContext is undefined.
   //
   // Guaranteed safe:
   //   - Empty / missing fields → element omitted entirely.
   //   - All fields empty → whole block omitted (no policy spam).
   //   - customInstructions sanitized (control tokens + length cap).
   //   - XML-escaped, single-insertion (never duplicated downstream).
   const userProfileBlock = renderUserProfileBlock(
     meta.userProfile,
     null /* policy stays English; see research findings note */
   );

   // 🧠 Memory MD injection — user-authored markdown from /api/me/memory-md.
   // This is the single SSOT for "what YUA should remember about me".
   // Wrapped in <user_memories> inside the reference stack so models get
   // it alongside their usual memoryContext hydration.
   // 🧠 Resolve the user id once — both skills and memory-md injection
   // branch off it. If the caller didn't thread userId in, both blocks
   // are skipped (we log once with a distinct warn so it's easy to spot
   // in the engine logs).
   const uidNum = Number(meta.userId);
   const hasUser = Number.isFinite(uidNum) && uidNum > 0;
   if (!hasUser) {
     console.warn(
       "[prompt-runtime] meta.userId missing — skills + memory-md injection skipped",
       { threadId: meta.threadId, hasUserProfile: !!meta.userProfile },
     );
   }

   // 🔥 PERF: ALL async I/O in ONE Promise.all — memoryMd + connectors + skills
   // Previously sequential blocks (memoryMd → skills), now fully parallel.
   let memoryMdBlock = "";
   let connectedProviders: string[] = [];
   let skillsBlock = "";
   const hasSlashSkill = !!meta.skillSlug;
   const isShallowChat = meta.reasoning?.depthHint !== "deep" && !hasSlashSkill;
   const skipSkills = args.mode === "FAST" || (args.mode === "NORMAL" && isShallowChat);

   if (hasUser) {
     const _t0 = Date.now();
     // 🔥 PERF: pgvector retrieval (retrieveTopSkills) calls OpenAI embedding API
     // (~200-500ms network). Only do it for DEEP mode or slash commands.
     const needsVectorRetrieval = (args.mode === "DEEP" || hasSlashSkill) && !skipSkills;

     const [mdResult, connectorsResult, skillsResult, preferredResult] = await Promise.all([
       // 1) memory-md
       _pgPool.query<{ markdown: string }>(
         `SELECT markdown FROM user_memory_md WHERE user_id = $1 LIMIT 1`,
         [uidNum],
       ).catch(() => ({ rows: [] as { markdown: string }[] })),
       // 2) connectors
       _listActiveConnectors(uidNum).catch(() => [] as any[]),
       // 3) skills list (skip if skipSkills)
       skipSkills
         ? Promise.resolve(null)
         : listInstalledSkills(uidNum).catch(() => null),
       // 4) vector retrieval (skip if not needed)
       needsVectorRetrieval
         ? retrieveTopSkills(sanitizedMessage, 5).catch(() => [] as string[])
         : Promise.resolve([] as string[]),
     ]);

     // Process memory-md result
     const md = (mdResult.rows[0]?.markdown || "").trim();
     if (md.length > 0) {
       const clean = md
         .replace(/<\/user_memories>/gi, "")
         .replace(/<\/memory>/gi, "");
       memoryMdBlock = `<user_memories>\n${clean}\n</user_memories>`;
     }
     connectedProviders = (Array.isArray(connectorsResult) ? connectorsResult : []).map((c: any) => c.provider);

     // Process skills result
     if (skillsResult && !skipSkills) {
       const enabled = skillsResult.filter((s) => s.enabled);
       let preferredSlugs = preferredResult;
       if (meta.skillSlug) {
         preferredSlugs = [meta.skillSlug, ...preferredSlugs.filter(s => s !== meta.skillSlug)];
       }
       skillsBlock = renderSkillsBlock(enabled, preferredSlugs);
       if (skillsBlock) {
         console.log("[prompt-runtime] skills injected", {
           total: skillsResult.length,
           enabled: enabled.length,
           chars: skillsBlock.length,
           preferred: preferredSlugs,
           vectorRetrieval: needsVectorRetrieval,
         });
       }
     } else if (skipSkills) {
       console.log("[prompt-runtime] skills SKIPPED", {
         mode: args.mode,
         depthHint: meta.reasoning?.depthHint,
         hasSlash: hasSlashSkill,
       });
     }
     console.log(`[PERF] prompt-runtime parallel-io: ${Date.now() - _t0}ms`);
   }

   // ── MCP tools: dynamic capability summary based on user's connected providers.
   // Prevents GPT from hallucinating "인증하라" when tools aren't connected.
   const PROVIDER_LABELS: Record<string, string> = {
     github: "GitHub (repos/issues/PRs/code)",
     gmail: "Gmail (email read/send/search)",
     gdrive: "Google Drive (files/folders/search)",
     google_calendar: "Google Calendar (events/schedules)",
     huggingface: "HuggingFace (datasets/models/papers)",
     context7: "Context7 (library documentation search)",
   };
   // connectedProviders는 위 병렬 로드에서 이미 설정됨
   const mcpPromptBlock = connectedProviders.length > 0
     ? `You have access to external tools: ${connectedProviders.map(p => PROVIDER_LABELS[p] ?? p).join(", ")}. Code execution and document generation are also available. Tools are loaded on demand — use them when the user's request requires external actions.`
     : "Code execution and document generation are available. No external MCP tools are connected for this session.";

   const baseReference =
     (meta.referenceContext && meta.referenceContext.trim().length > 0
       ? meta.referenceContext
       : meta.memoryContext && meta.memoryContext.trim().length > 0
       ? meta.memoryContext
       : "");

   // Phase D.7 — skillsBlock is now passed as a DEDICATED PromptBuilder
   // param, NOT merged into memoryContext. PromptBuilder wraps
   // memoryContext in "[REFERENCE CONTEXT] — 참고 맥락이다, 억지로
   // 연결하지 않는다" which makes the model treat the <skills> block as
   // background noise. Split it out so it renders under
   // [ENABLED SKILLS — AUTHORITATIVE CAPABILITY CATALOG].
   const headerBlocks = [userProfileBlock, memoryMdBlock]
     .filter((b) => b && b.length > 0)
     .join("\n\n");
   const enrichedReferenceContext =
     headerBlocks.length > 0
       ? baseReference.length > 0
         ? `${headerBlocks}\n\n${baseReference}`
         : headerBlocks
       : baseReference;

    // -------------------------------
  // 🎨 STYLE SIGNAL DETECTION (SSOT)
  // -------------------------------
// 🔒 SSOT: Tone must never be inferred or modified here
const styleHint = args.styleHint;


console.log("[TRACE][PROMPT_RUNTIME_ENTRY]", {
  messageLength: sanitizedMessage?.length ?? 0,
  turnIntent: meta.turnIntent,
  outmode: meta.outmode,
  depthHint: meta.reasoning?.depthHint,
});



 console.log("[DEBUG][PROMPT_RUNTIME_REFERENCE_CHECK]", {
   hasReferenceContext: !!meta.referenceContext,
   referenceLength: meta.referenceContext?.length ?? 0,
 });
   
    /* -------------------------------------------------- */
  /* 🔥 TOKEN PREFLIGHT GUARD (SSOT)                    */
  /* - PromptBuilder 호출 전 위험 차단                 */
  /* -------------------------------------------------- */

  // Use the enriched reference (profile block prepended + resolved
  // memory fallback). This is guaranteed string-typed by the block
  // above, so no further nullish chain is needed.
  const rawReference = enrichedReferenceContext;

  const cappedReference = trimByTokenBudget(
    rawReference,
    HARD_REF_TOKEN_CAP
  );

  const estimatedTokens =
    args.mode === "FAST"
      ? 0
      : estimateTokens(
          [
            sanitizedMessage,
            cappedReference,
            renderTrustedFacts(meta.trustedFacts)?.join("\n"),
            meta.constraints?.join("\n"),
          ]
            .filter(Boolean)
            .join("\n\n")
        );
   /* -------------------------------------------------- */
  /* 🔥 DESIGN INTENT RESOLUTION (SSOT)                 */
  /* -------------------------------------------------- */
  const isDesignLike =
     meta.executionPlan?.task === "CODE_GENERATION" ||
    meta.executionPlan?.task === "REFACTOR" ||
    // 🔒 SSOT: 코드 리뷰도 설계/분석 범주
    meta.executionPlan?.task === "CODE_REVIEW";

  const implementationMode =
    meta.executionPlan?.task === "CODE_GENERATION" ||
    meta.executionPlan?.task === "REFACTOR" ||
    meta.executionPlan?.task === "TYPE_ERROR_FIX" ||
    meta.executionPlan?.task === "RUNTIME_ERROR_FIX";

  // 🔥 SSOT: FOLLOW-UP은 "짧은 후속 질문"에서만 켠다.
  // - 새 주제 질문(길고 완결형)은 FOLLOW-UP 금지
    const isFollowUp =
    meta.continuityAllowed === true;
  // 🔒 SSOT: PromptRuntime에서는 CLARIFY / 요약 모드 강제 금지
  // 응답 성격은 Decision 단계에서만 결정한다

const TOKEN_LIMIT =
  args.mode === "FAST"
    ? 2000
    : args.mode === "DEEP"
    ? 32000
    : 6000;

  /* ---------------- HARD GUARD ---------------- */
  // 🔒 SSOT: Token overflow 시 "출력 금지"가 아니라
  const tokenOverflow =
    estimatedTokens > TOKEN_LIMIT * 1.2;

  const effectiveReferenceContext =
    [cappedReference, renderSignals(meta.signals)]
      .filter(Boolean)
      .join("\n\n");

  const effectiveMemoryContext = cappedReference;

  const effectiveReasoning = tokenOverflow && meta.reasoning
    ? {
        ...meta.reasoning,
        depthHint: "shallow" as const,
        stage: "explaining" as const,
        confidence:
          meta.reasoning.confidence != null
            ? Math.min(meta.reasoning.confidence, 0.45)
            : 0.45,
      }
    : meta.reasoning;



  const effectiveTrustedFacts =
    tokenOverflow
      ? meta.trustedFacts?.slice(0, 5)
      : meta.trustedFacts;

  const effectiveOutputTransformHint =
    tokenOverflow ? "SOFT_EXPAND" : meta.outputTransformHint;

  const effectiveResponseMode =
    tokenOverflow ? { mode: "ANSWER" as const } : meta.responseMode;

 const explanationRequested =
   meta.explanationRequested === true;

 const designMode =
   meta.toneBias?.profile === "DESIGNER" ||
   meta.executionPlan?.task === "CODE_GENERATION" ||
   meta.executionPlan?.task === "REFACTOR" ||
   meta.executionPlan?.task === "CODE_REVIEW" ||
   (meta.reasoning?.depthHint === "deep" &&
     meta.turnIntent === "QUESTION" &&
     meta.leadHint !== "SOFT" &&
     meta.responseMode?.mode !== "ANSWER");

 const guardedConstraints = [
   ...(effectiveConstraints ?? []),
   ...(meta.turnIntent === "QUESTION" &&
   (explanationRequested || meta.reasoning?.depthHint === "deep") &&
   !designMode
     ? [
         "이 질문은 단일 응답으로 자연스럽게 완결되는 설명이 적절하다.",
         "후속 논의나 다음 단계 제안은 필요하지 않다면 생략해도 된다.",
       ]
     : []),
 ];

  /* ---------------- SOFT GUARD ---------------- */
 const effectiveMode = args.mode;
 const thinkingProfile = args.thinkingProfile ?? "NORMAL";

   /**
   * 🔒 SSOT: DEEP + QUESTION 종료 가드
   * - DEEP는 깊이 허용이지 무한 확장 허가가 아니다
   * - QUESTION에서는 반드시 "완결형"으로 끝나야 한다
   * - 강제 행동 ❌, 힌트만 전달
   */
 const guardedOutputTransformHint =
   designMode
     ? undefined
     : effectiveOutputTransformHint;

// 🔥 SSOT GUARD: Invalid CONTINUATION rollback
 // 🔥 SSOT: CONTINUATION은 의미 신호가 있으면 QUESTION보다 우선
 const safeTurnIntent =
   meta.turnIntent === "CONTINUATION"
     ? "CONTINUATION"
     : meta.turnIntent;

        // 🔒 SSOT: PromptBuilder는 대화 제어용 intent만 허용
 const builderTurnIntent =
   safeTurnIntent === "QUESTION" ||
   safeTurnIntent === "CONTINUATION" ||
   safeTurnIntent === "SHIFT"
     ? safeTurnIntent
     : undefined;

    // 🔥 ROLLBACK: 출력 밀도 / 델타 제어 전부 제거
  // PromptRuntime는 출력 제어를 하지 않는다
// 🔒 SSOT: outputTransformHint is a constraint-only signal.
// PromptRuntime MUST NOT translate it into behavior.
// It is forwarded as-is to PromptBuilder.
 // 🔥 ROLLBACK: CONTINUATION framing 제거

  let executionContextBlock = "";
  if (meta.executionPlan && meta.executionResult?.ok) {
   const observationHints =
      (meta.executionResult.output as any)?.observation?.hints;

    executionContextBlock = observationHints
      ? `
[IMAGE OBSERVATION HINTS]
${observationHints.join("\n")}
`
      : "";
  }

  if (
    meta.executionPlan?.task === "FILE_INTELLIGENCE" &&
    meta.executionResult?.ok === true
  ) {
    meta.constraints = [
      ...(meta.constraints ?? []),
      "The uploaded file has already been opened locally. Do NOT say you cannot access external URLs.",
    ];
  }

    // PromptRuntime NEVER auto-falls back to Lite by token size
    /* -------------------------------------------------- */
  /* 🔥 BUILDER ROUTING (SSOT CORE)                     */
  /* -------------------------------------------------- */

  let message: string | undefined;

  /* ---------- FAST PATH ---------- */
  if (args.mode === "FAST") {
    // 🔥 SSOT: Vision 입력은 Lite Builder 금지 (덮어쓰기 버그 방지: else-if 체인)
    if (hasImage) {
      message = await PromptBuilder.buildChatPrompt(args.personaRole, finalUserMessage, {
        evidenceSignals,
        ...fileRagMeta,
        personaPermission: meta.personaPermission,
        attachments: builderAttachments,
        memoryContext: effectiveMemoryContext,
        skillsBlock,
        mcpPromptBlock,
        trustedFacts: renderTrustedFacts(effectiveTrustedFacts)?.join("\n"),
        constraints: guardedConstraints,
        styleHint,
        responseMode: effectiveResponseMode?.mode,
        outputTransformHint: guardedOutputTransformHint,
        policy: {
          allowSearch: meta.executionPlan?.task === "SEARCH",
          allowMemory: !!meta.memoryContext,
          restrictAnswer: false,
          forceUseTrustedFacts: true,
          forbidAccessLimitationMentions: true,
        },
      });
    } else if (
      safeTurnIntent === "QUESTION" &&
      meta.reasoning?.depthHint === "deep"
    ) {
      message = await PromptBuilder.buildChatPrompt(args.personaRole, finalUserMessage, {
        ...fileRagMeta,
        personaPermission: meta.personaPermission,
        memoryContext: effectiveMemoryContext,
        skillsBlock,
        mcpPromptBlock,
        trustedFacts: renderTrustedFacts(effectiveTrustedFacts)?.join("\n"),
        constraints: guardedConstraints,
        styleHint,
        responseMode: effectiveResponseMode?.mode,
        outputTransformHint: guardedOutputTransformHint,
        policy: {
          allowSearch: meta.executionPlan?.task === "SEARCH",
          allowMemory: !!meta.memoryContext,
          restrictAnswer: false,
        },
      });
    } else if (safeTurnIntent === "CONTINUATION") {
      message = await PromptBuilder.buildChatPrompt(
        args.personaRole,
        sanitizedMessage,
        {
          ...fileRagMeta,
          personaPermission: meta.personaPermission,
          memoryContext: effectiveMemoryContext,
          skillsBlock,
          mcpPromptBlock,
          trustedFacts: renderTrustedFacts(effectiveTrustedFacts)?.join("\n"),
          constraints: guardedConstraints,
          styleHint,
          responseMode: effectiveResponseMode?.mode,
          outputTransformHint: guardedOutputTransformHint,
          policy: {
            allowSearch: meta.executionPlan?.task === "SEARCH",
            allowMemory: !!meta.memoryContext,
            restrictAnswer: false,
          },
        }
      );
    } else {
      message = await PromptBuilder.buildChatPrompt(
        args.personaRole,
        finalUserMessage,
        {
          evidenceSignals,
          ...fileRagMeta,
          personaPermission: meta.personaPermission,
          memoryContext: effectiveMemoryContext,
          skillsBlock,
          mcpPromptBlock,
          trustedFacts: renderTrustedFacts(effectiveTrustedFacts)?.join("\n"),
          constraints: guardedConstraints,
          styleHint,
          responseMode: effectiveResponseMode?.mode,
          outputTransformHint: guardedOutputTransformHint,
          policy: {
            allowSearch: meta.executionPlan?.task === "SEARCH",
            allowMemory: !!meta.memoryContext,
            restrictAnswer: false,
          },
        }
      );
    }
  }

  /* ---------- DEEP PATH ---------- */
  else if (
    implementationMode
  ) {
message = await PromptBuilder.buildChatPrompt(
  args.personaRole,
  finalUserMessage,
  {
    // 🔥 implementation mode explicit override
    implementationMode: true,
    ...fileRagMeta,

    // ✅ NORMAL PATH와 동일한 안전 필드만 전달
    executionPlan: meta.executionPlan,
    executionResult: meta.executionResult,
    personaPermission: meta.personaPermission,
    turnIntent: builderTurnIntent,
    attachments: builderAttachments,
    responseMode: effectiveResponseMode?.mode,
    responseDensityHint: meta.responseDensityHint,
    outputTransformHint: guardedOutputTransformHint,
    memoryContext: effectiveReferenceContext,
    skillsBlock,
    mcpPromptBlock,
    trustedFacts: renderTrustedFacts(effectiveTrustedFacts)?.join("\n"),
    constraints: guardedConstraints,
    styleHint,

    // 🔒 tone은 PromptBuilder에서 implementationMode로 override됨
    tone: meta.toneBias?.profile
      ? meta.toneBias.profile === "DESIGNER"
        ? "structured-design"
        : "expert-friendly-explanatory"
      : undefined,

    policy: {
      allowSearch: meta.executionPlan?.task === "SEARCH",
      allowMemory: !!meta.memoryContext,
      restrictAnswer: false,
    },
  }
);
  }
  else if (
    thinkingProfile === "DEEP" &&
    meta.reasoning?.depthHint === "deep" &&
    (
      safeTurnIntent !== "CONTINUATION" ||
      (meta.anchorConfidence != null && meta.anchorConfidence >= 0.4)
    )
  ) {
 // DEEP path — `researchContext` is this builder's system-level
 // slot. We must also inject the `<user_profile>` block here or
 // DEEP-triggered turns silently drop the user's custom preferences.
 // Mirror the same fallback chain used above (memoryContext → ""),
 // then prepend the profile block if one was rendered.
 const deepBaseResearch =
   meta.memoryContext && meta.memoryContext.length > 0
     ? meta.memoryContext
     : "";
 const deepResearchContext = userProfileBlock
   ? (deepBaseResearch.length > 0
       ? `${userProfileBlock}\n\n${deepBaseResearch}`
       : userProfileBlock)
   : (deepBaseResearch.length > 0 ? deepBaseResearch : undefined);

 message = PromptBuilderDeep.build({
      message: [
        finalUserMessage,
        executionContextBlock,
      ]
        .filter(Boolean)
        .join("\n\n"),
      trustedFacts: renderTrustedFacts(effectiveTrustedFacts) ?? [],
    researchContext: deepResearchContext,
      depth:
        meta.reasoning?.depthHint === "deep"
          ? "DENSE"
          : "STANDARD",
      ssot: true,
    });
  }
  

  /* ---------- NORMAL PATH ---------- */
  else {
    message = await PromptBuilder.buildChatPrompt(
      args.personaRole,
      finalUserMessage,
      {
        evidenceSignals,
        ...fileRagMeta,
        // ✅ SSOT: PromptBuilder가 intent-aware 하게 동작하려면 꼭 전달
        personaPermission: meta.personaPermission,
        turnIntent: builderTurnIntent,
        attachments: builderAttachments,
        responseMode: effectiveResponseMode?.mode,
        responseDensityHint: meta.responseDensityHint,
        outputTransformHint: guardedOutputTransformHint,
        instanceId: (meta as any).personaContext?.instanceId ?? (meta as any).instanceId,
        memoryContext: effectiveReferenceContext,
        skillsBlock,
        mcpPromptBlock,
        trustedFacts: renderTrustedFacts(effectiveTrustedFacts)?.join("\n"),
         constraints:
   safeTurnIntent === "QUESTION" &&
   meta.reasoning?.depthHint !== "deep" &&
   meta.reasoning?.stage !== "solving"
     ? undefined
     : meta.constraints,
        styleHint,
         responseHint:
   safeTurnIntent === "CONTINUATION" ||
   meta.reasoning?.depthHint === "deep"
     ? meta.responseHint
     : undefined,
        depthHint: effectiveReasoning?.depthHint,
          // 🔥 SSOT: tone은 turnIntent가 아니라
          // reasoning 결과를 기반으로 결정
        tone:
          conversationalVision
            ? "friendly-step-by-step"
            : meta.toneBias?.profile === "DESIGNER"
            ? "structured-design"
            : meta.toneBias?.profile === "EXECUTIVE"
            ? "expert-friendly-explanatory"
            : meta.toneBias?.profile === "CASUAL"
            ? "friendly-step-by-step"
            : meta.toneBias?.profile
            ? "expert-friendly-explanatory"
            : undefined,
        executionPlan: meta.executionPlan,
        executionResult: meta.executionResult,
        policy: {
          allowSearch: meta.executionPlan?.task === "SEARCH",
          allowMemory: !!meta.memoryContext,
          restrictAnswer: false,
          }
        },
    );
  }

  // 🔒 SSOT HARD GUARD: PromptBuilder 결과 검증
  
 if (
   meta.executionPlan?.task !== "IMAGE_ANALYSIS" &&
   (!message || message.trim().length === 0)
 ) {
   throw new Error(
     "[SSOT_VIOLATION] PromptRuntime produced empty prompt"
   );
 }

 const uiThinkingAllowed =
  args.thinkingProfile === "DEEP";

  console.log(`[PERF] prompt-runtime TOTAL: ${Date.now() - _perfStart}ms`, { mode: args.mode });

  return {
    message,
    meta: {
      referenceContext: effectiveReferenceContext,
      trustedFacts: renderTrustedFacts(effectiveTrustedFacts)?.join("\n"),
      constraints: guardedConstraints,
      personaPermission: meta.personaPermission,
      reasoning: meta.reasoning,
      uiThinkingAllowed,
      fileRagConfidence: meta.fileRagConfidence,
      outmode: meta.outmode,
    },
  };
}
