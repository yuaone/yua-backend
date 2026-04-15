// 🔒 SSOT — ToolPlanItem → YuaExecutionPlan 변환
//
// 이전에는 chat-engine.ts와 design-engine.ts가 각자 같은 switch를 복제해서
// 유지했고, design-engine의 버전은 DOCUMENT_BUILDER → FILE_ANALYSIS 경로에서
// `attachments`를 payload에 넣지 않아 yua-tool-dispatcher.normalizeFileAnalysis
// 에서 `no file paths resolved` throw → chat 500이 발생했다. 이 파일이 둘의
// 유일한 진실 원본이다.
//
// 설계 원칙:
//   1. DOCUMENT_BUILDER는 **파일 첨부가 있어야만** FILE_ANALYSIS로 dispatch한다.
//      첨부 없으면 null을 반환해서 caller가 해당 plan item을 건너뛰도록 한다.
//      (decision-orchestrator도 같은 패턴: `if (!executionPlan && hasFile)`)
//   2. ToolPlanItem.payload의 원본 필드를 그대로 유지하고 attachments만 얹는다.
//   3. 지원하지 않는 tool은 `{ task: item.tool, payload }`로 pass-through한다.

import type { ToolPlanItem } from "./tool-plan-builder";

/**
 * Loose shape — callers cast to YuaExecutionPlan via `as unknown as` because
 * the shared YuaExecutionPlan requires additional fields (confidence) that
 * are injected downstream. Keep this untied to shared types to avoid import
 * version drift (yua-shared AttachmentMeta differs from yua-backend's
 * ../chat/types/attachment.types variant).
 */
export type LooseYuaPlan = {
  task: string;
  payload: Record<string, unknown>;
};

/**
 * Convert a ToolPlanItem into a loose YUA execution plan. Returns null when
 * the conversion must be skipped (e.g. DOCUMENT_BUILDER without file
 * attachments).
 */
export function toYuaExecutionPlan(
  item: ToolPlanItem,
  attachments?: unknown[]
): LooseYuaPlan | null {
  switch (item.tool) {
    case "PY_SOLVER":
      return { task: "PY_SOLVER", payload: { ...item.payload } };

    case "MARKET_DATA":
      return { task: "MARKET_DATA", payload: { ...item.payload } };

    case "WEB_FETCH":
      return { task: "WEB_FETCH", payload: { ...item.payload } };

    case "DOCUMENT_BUILDER": {
      const fileAttachments = Array.isArray(attachments)
        ? attachments.filter((a) => {
            if (!a || typeof a !== "object") return false;
            const rec = a as Record<string, unknown>;
            if (rec.kind !== "file") return false;
            return typeof rec.url === "string" || typeof rec.fileUrl === "string";
          })
        : [];

      if (fileAttachments.length === 0) {
        // No attachments to analyze — skip this plan item entirely so the
        // dispatcher never sees an empty FILE_ANALYSIS and throws 500.
        console.warn(
          "[TO_YUA_PLAN] DOCUMENT_BUILDER skipped — no file attachments on turn"
        );
        return null;
      }

      return {
        task: "FILE_ANALYSIS",
        payload: {
          ...item.payload,
          attachments: fileAttachments,
        },
      };
    }

    default:
      return { task: item.tool, payload: { ...item.payload } };
  }
}
