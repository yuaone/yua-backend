// 📂 src/ai/execution/execution-entry.ts
// 🔒 Execution Entry — SSOT FINAL
// 책임: Runtime 의존성 조립 ONLY

import crypto from "crypto";
import { pgPool } from "../../db/postgres";
import type { ExecutionPlan } from "./execution-plan";
import { runMediaPipeline } from "../image/media-orchestrator";
import { routeExecution } from "./execution-router";
import type { ExecutionResult } from "./execution-result";
import { StreamEngine } from "../engines/stream-engine";
import { StreamStage } from "yua-shared/stream/stream-stage";
import { ChatRuntime } from "../chat/runtime/chat-runtime";
import { CodeRuntime } from "../chat/runtime/code-runtime";
import { ImageRuntime } from "../chat/runtime/image-runtime";
import type { ChatRuntimeInput } from "../chat/runtime/chat-runtime";
import type { ChatMode } from "../chat/types/chat-mode";
import { OUTMODE } from "../chat/types/outmode";
import type { FactualVisualizationResult } from "./types/factual-visualization-result";
import { ensureImageSection } from "../../db/ensure-image-section";
import { MessageEngine } from "../engines/message-engine";
import { preprocessVisionInput } from "../vision/vision-orchestrator";
import { dispatchYuaExecutionPlan } from "../yua-tools/yua-tool-dispatcher";
import type { YuaExecutionPlan } from "yua-shared";
import { createFileSession } from "../../db/file-session-repository";
import { buildFileSessionSummary } from "../file/file-session-summary-adapter";
import path from "path";
import { runFileIntelligence } from "../file-intel/task/run-file-intelligence";
import type { FileIntelAttachment } from "../file-intel/types";
import type { DbClient } from "../file-intel/vector/db";
import type { Embedder as FileEmbedder } from "../file-intel/vector/embedder";

const UPLOADS_API_PREFIX = "/api/assets/uploads/";
const UPLOADS_LOCAL_PREFIX = "/mnt/yua/assets/uploads/";

function resolveToLocalPath(p: string): string {
  // Strip query string (e.g. ?token=...&exp=...)
  const clean = p.split("?")[0];

  if (clean.startsWith("https://storage.googleapis.com/")) {
    const m = clean.match(/yua-chat-uploads\/(.+)$/);
    if (m) {
      const relative = m[1];
      return path.resolve("/mnt/yua", relative);
    }
  }

  if (clean.startsWith(UPLOADS_API_PREFIX)) {
    if (clean.includes("..")) {
      throw new Error("FILE_INTELLIGENCE invalid uploads path");
    }
    return clean.replace(UPLOADS_API_PREFIX, UPLOADS_LOCAL_PREFIX);
  }

  if (clean.startsWith("http://") || clean.startsWith("https://")) {
    const url = new URL(p); // use original p for URL parsing
    const { pathname } = url;
    if (pathname.startsWith(UPLOADS_API_PREFIX)) {
      if (pathname.includes("..")) {
        throw new Error("FILE_INTELLIGENCE invalid uploads path");
      }
      return pathname.replace(UPLOADS_API_PREFIX, UPLOADS_LOCAL_PREFIX);
    }
    throw new Error("FILE_INTELLIGENCE unsupported file URL");
  }

  return clean;
}

function toFileIntelAttachments(
  attachments: {
    kind: "image" | "file";
    url: string;
    fileName?: string;
    mimeType?: string;
    sizeBytes?: number;
  }[]
): FileIntelAttachment[] {
  return attachments
    .filter((a) => a.kind === "file" && typeof a.url === "string")
    .map((a, i) => ({
      id: `att_${i}`,
      fileName: a.fileName ?? "file",
      mimeType: a.mimeType ?? null,
      sizeBytes: typeof a.sizeBytes === "number" ? a.sizeBytes : null,
      localPath: resolveToLocalPath(a.url),
    }));
}
export async function executePlan(
  plan: ExecutionPlan,
  ctx: {
    threadId: number;
    traceId: string;
    workspaceId: string;
    userId?: number;
    userName?: string | null;
    sectionId?: number;
    sectionType?: string;
    message: string;
    attachments?: {
      kind: "image" | "file";
      url: string;
      fileName?: string;
      mimeType?: string;
      sizeBytes?: number;
    }[];
    db?: DbClient;
    fileEmbedder?: FileEmbedder;
    fileSessionId?: string;
    prompt?: string;
    mode?: ChatMode;
    thinkingProfile?: "FAST" | "NORMAL" | "DEEP";
    outmode?: OUTMODE;
    stream?: boolean;
    path?: string;
    forceSearch?: boolean;
    visionBudget?: {
      allowOCR?: boolean;
      allowZoom?: boolean;
      allowCrop?: boolean;
      maxImages?: number;
    };
  }
): Promise<ExecutionResult> {
  let sectionIdForImage: number | undefined;
  let visionConfidence: number | undefined; // 🔥 ADD (function scope)
  /* ----------------------------------
     🔧 TOOL EXECUTION (SSOT)
     - Decision에서 선언된 Tool Plan 실행
     - Chat/Image Runtime과 완전 분리
  ---------------------------------- */
  if (plan.task === "FILE_INTELLIGENCE") {
    if (!ctx.db || !ctx.fileEmbedder) {
      return {
        ok: false,
        plan,
        error: {
          code: "FILE_INTELLIGENCE_DEPS_MISSING",
          message: "FILE_INTELLIGENCE requires db and fileEmbedder",
        },
      };
    }

    const fileAttachments = Array.isArray(ctx.attachments)
      ? toFileIntelAttachments(ctx.attachments)
      : [];

    if (fileAttachments.length === 0) {
      return {
        ok: false,
        plan,
        error: {
          code: "FILE_INTELLIGENCE_NO_ATTACHMENTS",
          message: "FILE_INTELLIGENCE requires file attachments",
        },
      };
    }

    const result = await runFileIntelligence({
      attachments: fileAttachments,
      message: ctx.message,
      workspaceId: ctx.workspaceId,
      threadId: ctx.threadId,
      db: ctx.db,
      embedder: ctx.fileEmbedder,
    });

    ctx.fileSessionId = result.sessionId;

    // 🔒 FILE SESSION: thread에 파일 세션 바인딩 (다음 메시지에서 참조 가능)
    try {
      await createFileSession({
        threadId: ctx.threadId,
        workspaceId: ctx.workspaceId,
        toolRunId: result.sessionId ?? crypto.randomUUID(),
        inputsHash: fileAttachments.map(f => f.fileName ?? f.id).join("|"),
        filesJson: JSON.stringify(fileAttachments),
        summaryJson: JSON.stringify(typeof result.summary === "string" ? { text: result.summary } : (result.summary ?? null)),
      });
    } catch (e) {
      console.error("[FILE_SESSION_CREATE_ERROR]", {
        traceId: ctx.traceId,
        error: String(e),
      });
    }

    return {
      ok: true,
      plan,
      output: result,
    };
  }

  if (
    plan.task === "FILE_ANALYSIS" ||
    plan.task === "TABLE_EXTRACTION" ||
    plan.task === "DATA_TRANSFORM"
  ) {
    // Pre-flight guard — mirror FILE_INTELLIGENCE pattern.
    //
    // If the LLM planned a FILE_ANALYSIS / TABLE_EXTRACTION / DATA_TRANSFORM
    // task but neither the payload nor the turn's attachments carry any
    // usable file path, the downstream normalizer inside
    // `dispatchYuaExecutionPlan` throws synchronously — the throw
    // bubbles through executePlan and chat-controller and lands in
    // pm2 error logs as "FILE_ANALYSIS normalization failed: no file
    // paths resolved". Short-circuit here with a soft failure so the
    // chat flow continues gracefully.
    const payloadFiles = Array.isArray((plan as any).payload?.filePaths)
      ? (plan as any).payload.filePaths.filter(
          (p: unknown) => typeof p === "string" && p.length > 0,
        )
      : [];
    const attachmentFiles = Array.isArray(ctx.attachments)
      ? ctx.attachments.filter((a: any) => a?.kind === "file")
      : [];
    if (payloadFiles.length === 0 && attachmentFiles.length === 0) {
      return {
        ok: false,
        plan,
        error: {
          code: "TOOL_NO_FILES",
          message: `${plan.task} planned without any file paths or attachments`,
        },
      };
    }

    // Wrap the dispatcher call so any unexpected throw (e.g. a future
    // tool normalizer that raises for a different reason) is surfaced
    // as a soft error rather than a bubbling exception.
    let toolRunId: string;
    let result: Awaited<ReturnType<typeof dispatchYuaExecutionPlan>>["result"];
    try {
      const dispatched = await dispatchYuaExecutionPlan(
        plan as unknown as YuaExecutionPlan,
        {
          traceId: ctx.traceId,
          workspaceId: ctx.workspaceId,
          threadId: ctx.threadId,
        },
      );
      toolRunId = dispatched.toolRunId;
      result = dispatched.result;
    } catch (e: any) {
      console.warn("[executePlan] dispatch threw", {
        task: plan.task,
        err: e?.message ?? String(e),
      });
      return {
        ok: false,
        plan,
        error: {
          code: "TOOL_DISPATCH_THROW",
          message: e?.message ?? "Tool dispatch failed",
        },
      };
    }
if (result.status === "ERROR") {
  return {
    ok: false,
    plan,
 error:
   typeof result.error === "object" && result.error
     ? {
         code: result.error.code ?? "TOOL_ERROR",
         message: result.error.message ?? "Tool execution failed",
       }
     : {
         code: "TOOL_ERROR",
         message: String(result.error ?? "Tool execution failed"),
       },
  };
}

  // 🔥 FILE SESSION CREATION (SAFE)
  if (plan.task === "FILE_ANALYSIS" && result.status === "OK") {
    try {
      const summaryJson = buildFileSessionSummary(result);

      const inputsHash =
        result.provenance?.inputsHash ?? "";

      const filesJson =
        result.provenance?.sources?.filter(
          s => s.kind === "FILE"
        ) ?? [];

      await createFileSession({
        threadId: ctx.threadId,
        workspaceId: ctx.workspaceId,
        toolRunId,
        inputsHash,
        filesJson,
        summaryJson,
      });
    } catch (e) {
      console.error("[FILE_SESSION_CREATE_ERROR]", {
        traceId: ctx.traceId,
        error: String(e),
      });
      // ❗ 절대 throw 하지 않는다 (runtime 안전성 유지)
    }
  }

return {
  ok: true,
  plan,
  output: result,
  evidenceSignals: [],
};
  }
  // 0️⃣ IMAGE_GENERATION은 Runtime 없이 Media Pipeline만 실행
  if (plan.task === "IMAGE_GENERATION") {
    if (ctx.workspaceId) {
      const { sectionId } = await ensureImageSection({
        workspaceId: ctx.workspaceId,
        threadId: ctx.threadId,
      });
      sectionIdForImage = sectionId;

      if (ctx.userId && ctx.traceId) {
        const exists = await MessageEngine.existsAssistantByTrace(
          ctx.threadId,
          ctx.traceId
        );

        if (!exists) {
          console.log("[EXEC][IMAGE_GENERATION_PERSIST]", {
            threadId: ctx.threadId,
            traceId: ctx.traceId,
            sectionId,
          });
          await MessageEngine.addMessage({
            threadId: ctx.threadId,
            userId: ctx.userId,
            role: "assistant",
            content: "",
            traceId: ctx.traceId,
            meta: {
              studio: { sectionId, assetType: "IMAGE", traceId: ctx.traceId },
            },
          });
        }
      }

      if (ctx.userId) {
        await MessageEngine.addMessage({
          threadId: ctx.threadId,
          userId: ctx.userId,
          role: "system",
          content: "",
          traceId: ctx.traceId,
          meta: {
            studio: { sectionId, assetType: "IMAGE" },
            isImageOnly: true,
          },
        });
      }

      await StreamEngine.publish(ctx.threadId, {
        event: "stage",
        stage: StreamStage.ANALYZING_IMAGE,
        traceId: ctx.traceId,
        meta: {
          studio: { sectionId, assetType: "IMAGE" },
          isImageOnly: true,
        },
      });

      // Emit activity with IMAGE_PANEL artifact for DeepDrawer
      const imageUrl = ctx.attachments?.find(a => a.kind === "image")?.url;
      if (imageUrl) {
        await StreamEngine.publish(ctx.threadId, {
          event: "activity",
          stage: StreamStage.ANALYZING_IMAGE,
          traceId: ctx.traceId,
          activity: {
            op: "ADD",
            item: {
              id: `image_analysis:${ctx.traceId}`,
              kind: "IMAGE_ANALYSIS" as any,
              status: "RUNNING",
              title: "Analyzing image",
              at: Date.now(),
              artifact: {
                kind: "IMAGE_PANEL",
                imageUrl,
                caption: "Analyzing...",
              },
            },
          },
        });
      }

      try {
        await runMediaPipeline({
          threadId: ctx.threadId,
          traceId: ctx.traceId,
          sectionId,
          sectionType: "RESULT",
          message: plan.payload.message,
        });
        await StreamEngine.finish(ctx.threadId, {
          reason: "completed",
        });
      } catch (e: any) {
        console.warn("[MEDIA_PIPELINE][DEGRADED]", {
          traceId: ctx.traceId,
          error: String(e),
        });

        // ── Image generation failed — persist error state so the frontend
        // can render a placeholder on reload + finalize the stream so the
        // user isn't stuck on a loading spinner. Without this, the assistant
        // message meta only has studio.sectionId and 0 assets, so the UI
        // has no way to tell success-in-progress from hard failure.
        const rawMsg = String(e?.message ?? e ?? "");
        const reason =
          rawMsg.includes("moderation_blocked") || rawMsg.includes("safety system")
            ? "moderation_blocked"
            : rawMsg.includes("rate_limit") || rawMsg.includes("429")
              ? "rate_limited"
              : "generation_failed";
        const userFacing =
          reason === "moderation_blocked"
            ? "이미지 생성이 안전 정책에 걸렸어요. 프롬프트를 수정해서 다시 시도해주세요."
            : reason === "rate_limited"
              ? "이미지 생성 한도에 도달했어요. 잠시 후 다시 시도해주세요."
              : "이미지 생성에 실패했어요. 잠시 후 다시 시도해주세요.";

        if (ctx.traceId) {
          try {
            await pgPool.query(
              `UPDATE chat_messages
                  SET meta = COALESCE(meta, '{}'::jsonb) || $1::jsonb
                WHERE thread_id = $2
                  AND trace_id = $3
                  AND role = 'assistant'`,
              [
                JSON.stringify({
                  imageError: true,
                  imageErrorReason: reason,
                  imageErrorMessage: userFacing,
                  imageLoading: false,
                }),
                ctx.threadId,
                ctx.traceId,
              ],
            );
          } catch (pgErr) {
            console.warn("[MEDIA_PIPELINE][META_UPDATE_FAIL]", pgErr);
          }

          // Re-publish error stage so live stream listeners also know
          try {
            await StreamEngine.publish(ctx.threadId, {
              event: "stage",
              stage: StreamStage.SYSTEM,
              traceId: ctx.traceId,
              meta: {
                imageLoading: false,
                imageError: true,
                imageErrorReason: reason,
                imageErrorMessage: userFacing,
              },
            });
          } catch {}
        }

        try {
          await StreamEngine.finish(ctx.threadId, {
            reason: "error",
          });
        } catch {}
      }
    }

    return {
      ok: true,
      plan,
      output: null,
      sectionId: sectionIdForImage,
    };
  }

  // 1️⃣ 먼저 Runtime 실행
  const isChatPlan =
    plan.task === "DIRECT_CHAT" ||
    plan.task === "SEARCH_VERIFY" ||
    plan.task === "SEARCH";

  if (
    isChatPlan &&
    (!ctx.prompt || !ctx.mode || typeof ctx.stream !== "boolean")
  ) {
    throw new Error("[SSOT_VIOLATION] CHAT_RUNTIME_CONTEXT_MISSING");
  }


  const chatRuntimeInput: ChatRuntimeInput | undefined = isChatPlan
    ? {
        message: plan.payload.message,
        prompt: ctx.prompt ?? "",
        threadId: ctx.threadId,
        traceId: ctx.traceId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId!,
        userName: ctx.userName,
        mode: ctx.mode as ChatMode,
        thinkingProfile: ctx.thinkingProfile as ChatRuntimeInput["thinkingProfile"],
        outmode: ctx.outmode,
        stream: ctx.stream as boolean,
        path: ctx.path,
        forceSearch: ctx.forceSearch,
      }
    : undefined;

  const result = await routeExecution(
    plan,
    {
      chatRuntime: ChatRuntime,
      codeRuntime: CodeRuntime,
      imageRuntime: ImageRuntime,
    },
    { chatRuntimeInput }
  );

    /**
   * 🔒 SSOT: ExecutionResult Output Guard
   * - IMAGE side-effect는 "실질 출력"이 있을 때만 허용
   * - PromptRuntime 침묵 / soft-degrade 상태에서는 금지
   */
  const hasEffectiveOutput =
    result.ok &&
    result.output != null &&
    (typeof result.output !== "string" ||
      result.output.trim().length > 0);

    /* ----------------------------------
     🖼️ IMAGE SIDE-EFFECT (SSOT)
     - ExecutionEntry is the ONLY place
     - Stream / Prompt logic NEVER triggers media
  ---------------------------------- */
const hasImageAttachments =
  ctx.attachments?.some(a => a.kind === "image");

if (
  plan.task === "IMAGE_ANALYSIS" &&
  plan.payload?.nextAction === "GENERATE_ASSET" &&
  hasImageAttachments &&
  ctx.workspaceId &&
  hasEffectiveOutput
) {
   const imageAttachments =
     ctx.attachments
       ?.filter(
         (a): a is { kind: "image"; url: string } =>
           a.kind === "image" && typeof (a as any).url === "string"
       )
       .slice(
         0,
         typeof ctx.visionBudget?.maxImages === "number"
           ? ctx.visionBudget.maxImages
           : 3 // 🔒 안전 기본값
       )
       .map((a) => ({ kind: "image" as const, url: (a as any).url }));

   if (!imageAttachments || imageAttachments.length === 0) {
     console.warn("[MEDIA_PIPELINE][SKIPPED_NO_IMAGE_ATTACHMENTS]", {
       traceId: ctx.traceId,
     });
   } else {
    /* ----------------------------------
       🧠 VISION PREPROCESS (SSOT)
       - deterministic
       - never throws
       - no network
    ---------------------------------- */
    const vision = await preprocessVisionInput({
      attachments: imageAttachments,
      message: ctx.message,
      visionBudget: ctx.visionBudget,
    });

    // 🔥 SSOT: Vision confidence snapshot (ExecutionResult payload ONLY)
    visionConfidence =
      typeof vision?.signals?.confidence === "number"
        ? vision.signals.confidence
        : undefined;

    const finalAttachments = vision.processedAttachments;

    // optional context injection (non-breaking)
    const finalMessage =
      vision.contextText
        ? `${vision.contextText}\n\n${ctx.message}`
        : ctx.message;
     const { sectionId } = await ensureImageSection({
       workspaceId: ctx.workspaceId,
       threadId: ctx.threadId,
     });
     sectionIdForImage = sectionId;

     await StreamEngine.publish(ctx.threadId, {
       event: "stage",
       stage: StreamStage.ANALYZING_IMAGE,
       traceId: ctx.traceId,
       meta: {
         studio: { sectionId, assetType: "IMAGE" },
         imageLoading: true,
       },
     });

     // Emit activity with IMAGE_PANEL artifact for DeepDrawer
     const panelUrl = finalAttachments?.[0]?.url ?? imageAttachments[0]?.url;
     if (panelUrl) {
       await StreamEngine.publish(ctx.threadId, {
         event: "activity",
         stage: StreamStage.ANALYZING_IMAGE,
         traceId: ctx.traceId,
         activity: {
           op: "ADD",
           item: {
             id: `image_analysis:${ctx.traceId}:asset`,
             kind: "IMAGE_ANALYSIS" as any,
             status: "RUNNING",
             title: "Analyzing image",
             at: Date.now(),
             artifact: {
               kind: "IMAGE_PANEL",
               imageUrl: panelUrl,
               caption: "Processing image...",
             },
           },
         },
       });
     }

     if (ctx.userId && ctx.traceId) {
       const exists = await MessageEngine.existsAssistantByTrace(
         ctx.threadId,
         ctx.traceId
       );
     if (!exists) {
         console.log("[EXEC][IMAGE_ANALYSIS_PERSIST]", {
           threadId: ctx.threadId,
           traceId: ctx.traceId,
           sectionId,
         });
         await MessageEngine.addMessage({
           threadId: ctx.threadId,
           userId: ctx.userId,
           role: "assistant",
           content: "",
           traceId: ctx.traceId,
           meta: {
             studio: { sectionId, assetType: "IMAGE", traceId: ctx.traceId },
           },
         });
       }
     }

     try {
       await runMediaPipeline({
         threadId: ctx.threadId,
         traceId: ctx.traceId,
         sectionId,
         sectionType: "RESULT",
         message: finalMessage,
         attachments: finalAttachments,
       });
       await StreamEngine.finish(ctx.threadId, {
         reason: "completed",
       });
     } catch (e) {
       console.warn("[MEDIA_PIPELINE][DEGRADED]", {
         traceId: ctx.traceId,
         error: String(e),
       });
     }
   }
}
  /* ----------------------------------
     🔎 SEARCH ACTIVITY EMIT (SSOT SAFE)
     - SEARCH / SEARCH_VERIFY only
     - emit once
     - never touches tokens
  ---------------------------------- */
  if (
    result.ok &&
    (plan.task === "SEARCH" || plan.task === "SEARCH_VERIFY")
  ) {
  const searchOutput = result.output as any;

  // 🔒 CRITICAL GUARD: 실제 검색 수행된 경우만 activity 허용
  if (
    searchOutput?.executed === true &&
    Array.isArray(searchOutput?.evidenceItems) &&
    searchOutput.evidenceItems.length > 0
  ) {
    await StreamEngine.publish(ctx.threadId, {
      event: "activity",
      stage: StreamStage.THINKING,
      traceId: ctx.traceId,
      meta: {
        kind: "search.results",
        items: searchOutput.evidenceItems.slice(0, 8),
      },
    } as any);
  }
  }



  // 3️⃣ ExecutionResult 반환 (Prompt/Chat 흐름용)
  if (result.ok) {
 await StreamEngine.publish(ctx.threadId, {
    event: "stage",
    stage: StreamStage.ANSWER_UNLOCKED,
    traceId: ctx.traceId,
  });
    return {
      ok: true,
      plan,
      output: result.output,
      sectionId: sectionIdForImage ?? ctx.sectionId,  // 🔥 FIX
      visionConfidence, // 🔥 ADD (optional field)
      // 🔒 SSOT: EvidenceSignal은 전달만 한다 (판단/가공 ❌)
      evidenceSignals:
        (result as any).evidenceSignal
          ? [(result as any).evidenceSignal]
          : [],
    };
  }

  return {
    ok: false,
    plan,
    error: result.error,
  };
}
