// 📂 src/routes/index.ts
// 🔥 YUA-AI Engine — Root Router MASTER FINAL (SSOT FIXED)

import { Router } from "express";
import { requireFirebaseAuth } from "../auth/auth.express";
import { requireAuthOrApiKey } from "../auth/auth-or-apikey";
import { withWorkspace } from "../middleware/with-workspace";
/* ==============================
   SYSTEM / SECURITY
============================== */
import { checkUsageGate } from "../middleware/check-usage-gate";
import { attackMonitor } from "../middleware/attack-monitor";
import { autoEngineDB } from "../middleware/auto-engine-db";
import { aiEngineLimiter } from "../middleware/engine-limiter";
import { rateLimit } from "../middleware/rate-limit";

/* ==============================
   ROOT / AUTH
============================== */
import healthRouter from "./health-router";
import authRouter from "./auth-router";
import meRouter from "./me-router";
import usageRouter from "./usage";

/* ==============================
   CHAT (SSOT)
============================== */
// 🔥 Firebase + API Key — User Chat Resource
import chatUserRouter from "./chat-user.router";
import chatUploadRouter from "./chat-upload.router";
import projectRouter from "./project.router";

// 🔒 Legacy / Completion Chat
import chatRouter from "./chat-router";
import streamAbortRouter from "./stream-abort";
/* ==============================
   OTHER ROUTERS (생략 없음)
============================== */
import financeRouter from "./finance-router";
import bizRouter from "./biz-router";
import riskRouter from "./risk-router";
import reportRouter from "./report-router";
import matchRouter from "./match-router";
import aiRouter from "./ai-router";
import researchRouter from "./research-router";
import docRouter from "./doc-router";
import securityRouter from "./security-router";
import identityRouter from "./identity-router";
import agentRouter from "./agent-router";
import documentRouter from "./document-router";
import taskRouter from "./task-router";
import videoRouter from "./video-router";
import audioRouter from "./audio-router";
import evalRouter from "./eval-router";
import secureRouter from "./secure-router";
import codeRouter from "./code-router";
import reasoningRouter from "./reasoning-router";
import WorkflowRouter from "./workflow-router";
import LogsRouter from "./logs-router";
import SettingsRouter from "./settings-router";
import ApiKeyRouter from "./api-key-router";
import DevRouter from "./dev-router";
import SuperAdminRouter from "./superadmin-router";
import auditRouter from "./audit-router";
import EngineRouter from "./engine-router";
import mysqlTestRouter from "./mysql-test-router";
import vectorRouter from "./vector-router";
import postgresRouter from "./postgres-router";
import emotionRouter from "./emotion-router";
import styleRouter from "./style-router";
import compressRouter from "./compress-router";
import threatRouter from "./threat-router";
import attackRouter from "./attack-router";
import controlRouter from "./control-router";
import billingRouter from "./billing-router";
import billingStatusRouter from "./billing-status-router";
import billingV2Router from "./billing-v2-router";
import billingPlayRouter from "./billing-play-router";
import businessRouter from "./business-router";
import InstanceRouter from "./instance-router";
import terminalRouter from "./terminal-router";
import fsRouter from "./fs-router";
import YuaBasicRouter from "./yua/basic-router";
import YuaProRouter from "./yua/pro-router";
import YuaAssistantRouter from "./yua/assistant-router";
import YuaDevRouter from "./yua/dev-router";
import assetRouter from "./asset-router";
import uploadAssetsRouter from "./upload-assets.router";
import studioRouter from "./studio-router";
import sectionAssetsRouter from "./section-assets.router";
import workspaceMeRouter from "./workspace-me-router";
import workspaceRouter from "./workspace-router";
import voiceRouter from "./voice-router";
import shareRouter from "./share-router";
import memoryRouter from "./memory-router";
import { adminRouter } from "./admin-router";
import supportRouter from "./support-router";
import supportInboundRouter from "./support-inbound-router";
import platformApiKeysRouter from "./api-keys-router";
import v1CompletionsRouter from "./v1-completions-router";
import v1EmbeddingsRouter from "./v1-embeddings-router";
import yuanAgentRouter from "./yuan-agent-router";
import yuanLlmRouter from "./yuan-llm-router";
import yuanAuthRouter from "./yuan-auth-router";
import pluginMarketplaceRouter from "./plugin-marketplace-router";
import authDeviceRouter from "./auth-device-router";
import libraryRouter from "./library-router";
import searchRouter from "./search-router";
import { requirePaidPlan } from "../middleware/require-paid-plan";

/* ==============================
   SETTINGS v2 (Batch 4)
============================== */
import billingLsRouter from "./billing-ls-router";
import accountRouter from "./account-router";
import privacyRouter from "./privacy-router";
import connectorsRouter from "./connectors-router";
import connectorsOAuthRouter from "./connectors-oauth-router";
import skillsRouter from "./skills-router";
import memoryMdRouter from "./memory-md-router";
import artifactRouter from "./artifact-router";
import usageDetailedRouter from "./usage-detailed-router";
import { resolvePlanTier } from "../middleware/resolve-plan-tier";

/* ================================================== */
const router = Router();
console.log("[ROUTER] index.ts loaded");

/* ==================================================
   🔓 PUBLIC
================================================== */
router.use("/health", healthRouter);
router.use("/auth", rateLimit, authRouter);
router.use("/", shareRouter);  // GET /share/:token (public) + POST /chat/share (auth inside)
router.use("/yuan-auth", yuanAuthRouter);  // OAuth Device Flow for CLI (auth handled per-endpoint)
router.use("/auth/device", authDeviceRouter);  // CLI/Desktop device token management
router.use("/support/inbound", rateLimit, supportInboundRouter);

/* ==================================================
   🔑 ADMIN / DEV (auth + rate limit required)
================================================== */
router.use("/key", requireFirebaseAuth, rateLimit, ApiKeyRouter);
router.use("/dev", requireFirebaseAuth, rateLimit, DevRouter);
router.use("/superadmin", requireFirebaseAuth, rateLimit, SuperAdminRouter);
router.use("/audit", requireFirebaseAuth, withWorkspace, rateLimit, auditRouter);
router.use("/admin", adminRouter); // admin-session middleware handles auth internally

/* ==================================================
   🌐 V1 API (OpenAI-compatible)
   👉 /api/v1/chat/completions
================================================== */
router.use("/v1", v1CompletionsRouter);
router.use("/v1", v1EmbeddingsRouter);

/* ==================================================
   🔧 ENGINE / DB CONTEXT (🔥 반드시 먼저)
================================================== */
router.use(autoEngineDB);

/* ==================================================
   👤 AUTH CONTEXT (🔥 반드시 chat 전에)
================================================== */
router.use("/me", meRouter);
router.use("/usage", requireFirebaseAuth, withWorkspace, usageRouter);
// Settings v2 — detailed usage breakdown (/api/usage/detailed)
router.use("/usage", requireFirebaseAuth, withWorkspace, resolvePlanTier, usageDetailedRouter);
// Settings v2 — account tab (sessions, delete account)
router.use("/account", requireFirebaseAuth, withWorkspace, resolvePlanTier, accountRouter);
// Settings v2 — privacy tab (data export + delete request log)
router.use("/privacy", privacyRouter);
// Settings v2 — connectors tab (waitlist + OAuth phase 2)
// The OAuth callback endpoint (GET /connectors/:id/callback) is provider-called
// and CANNOT require Firebase auth — it's wired first (public) so the authed
// catalog handler below matches everything else.
router.use("/connectors", connectorsOAuthRouter);
router.use("/connectors", requireFirebaseAuth, withWorkspace, resolvePlanTier, connectorsRouter);
router.use("/skills", requireFirebaseAuth, skillsRouter);
router.use("/artifacts", requireFirebaseAuth, artifactRouter);
router.use("/library", requireFirebaseAuth, withWorkspace, libraryRouter);
router.use("/search", requireFirebaseAuth, withWorkspace, searchRouter);
router.use("/me/memory-md", requireFirebaseAuth, memoryMdRouter);
router.use("/workspace/me", workspaceMeRouter);
/* ==================================================
   ✅ USER CHAT (Firebase + API Key)
   👉 /api/chat/*
================================================== */
 // ✅ chatController가 req.workspace를 요구하므로, chat 라우트는 auth 후 withWorkspace를 보장해야 함
 router.use("/chat", requireAuthOrApiKey("yua"), withWorkspace, resolvePlanTier, chatRouter);
 router.use("/chat", requireAuthOrApiKey("yua"), resolvePlanTier, chatUserRouter);
 router.use("/chat", requireAuthOrApiKey("yua"), withWorkspace, resolvePlanTier, chatUploadRouter);
 
  /* ==================================================
   📊 CHAT TELEMETRY
   👉 /api/chat/suggestion/feedback
================================================== */
router.use("/telemetry", controlRouter);

 /* ==================================================
   🛑 STREAM CONTROL (SSOT)
   👉 /api/chat/stream/abort
================================================== */
router.use("/chat/stream", streamAbortRouter);

 /* ==================================================
   🧠 MEMORY API (Firebase + Workspace)
   👉 /api/memory/*
================================================== */
router.use("/memory", requireFirebaseAuth, withWorkspace, memoryRouter);

 /* ==================================================
   📁 PROJECT (Workspace / Sidebar Context)
   👉 /api/project/*
================================================== */
router.use("/project", projectRouter);
router.use("/workspace", workspaceRouter);
 /* ==================================================
   📄 DOCUMENT (Rewrite / Assets)
   👉 /api/document/*
   ❌ usage / engine limiter 없음
================================================== */
router.use("/document", documentRouter);

/* ==================================================
   🔒 API KEY REQUIRED
================================================== */
// signed URL 접근은 인증 불필요 (token+exp로 검증)
router.use("/assets", uploadAssetsRouter);
router.use("/assets", requireAuthOrApiKey("yua"), withWorkspace, assetRouter);
router.use(
  "/sections",
  requireAuthOrApiKey("yua"),
  withWorkspace,
  sectionAssetsRouter
);
router.use(
  "/studio",
  requireFirebaseAuth,
  withWorkspace,
  studioRouter
);
router.use("/finance", checkUsageGate, financeRouter);
router.use("/biz", checkUsageGate, bizRouter);
router.use("/risk", checkUsageGate, riskRouter);
router.use("/report", checkUsageGate, reportRouter);
router.use("/match", checkUsageGate, matchRouter);
router.use("/ai", checkUsageGate, aiRouter);

/* YUA 5-MODE */
router.use("/ai/basic", checkUsageGate, YuaBasicRouter);
router.use("/ai/pro", checkUsageGate, YuaProRouter);
router.use("/ai/assistant", checkUsageGate, YuaAssistantRouter);
router.use("/ai/dev", checkUsageGate, YuaDevRouter);

/* MULTI ENGINE */
router.use("/research", aiEngineLimiter, researchRouter);
router.use("/doc", aiEngineLimiter, docRouter);
router.use("/security", aiEngineLimiter, securityRouter);
router.use("/identity", aiEngineLimiter, identityRouter);
router.use("/agent", aiEngineLimiter, agentRouter);

/* YUAN CODING AGENT (Firebase OR API key + Workspace + 유료 플랜) */
router.use("/yuan-agent", requireAuthOrApiKey("yua"), withWorkspace, requirePaidPlan(), yuanAgentRouter);
/* YUAN LLM — Stateless LLM endpoint (DB 터치 없음, YUAN agent 두뇌) */
router.use("/yuan-agent/llm", requireAuthOrApiKey("yua"), withWorkspace, requirePaidPlan(), yuanLlmRouter);
/* PLUGIN MARKETPLACE (Firebase OR API key + Workspace) */
router.use("/plugin-marketplace", requireAuthOrApiKey("yua"), withWorkspace, pluginMarketplaceRouter);
router.use("/task", aiEngineLimiter, taskRouter);
router.use("/video", aiEngineLimiter, videoRouter);
router.use("/audio", aiEngineLimiter, audioRouter);
router.use("/voice", voiceRouter);


/* ENGINE / DB (auth required) */
router.use("/engine", requireFirebaseAuth, EngineRouter);
router.use("/mysql", requireFirebaseAuth, mysqlTestRouter);
router.use("/vector", requireFirebaseAuth, vectorRouter);
router.use("/postgres", requireFirebaseAuth, postgresRouter);
router.use("/emotion", emotionRouter);
router.use("/style", styleRouter);
router.use("/compress", compressRouter);

/* THREAT */
router.use("/threat", threatRouter);
router.use(attackMonitor);
router.use("/attack", attackRouter);

/* BUSINESS */
// LS webhook (PUBLIC — HMAC auth inside). MUST come before authed billing routes.
router.use("/billing", billingLsRouter);
router.use("/billing", requireFirebaseAuth, withWorkspace, billingStatusRouter);
router.use("/billing", requireFirebaseAuth, withWorkspace, billingRouter);
router.use("/billing", requireFirebaseAuth, withWorkspace, billingV2Router);
router.use("/billing", requireFirebaseAuth, withWorkspace, billingPlayRouter);
router.use("/business", businessRouter);

/* SUPPORT (User-facing ticket system) */
router.use("/support", requireFirebaseAuth, withWorkspace, supportRouter);

/* PLATFORM (API Key CRUD + Test Playground) */
router.use("/platform", requireFirebaseAuth, withWorkspace, platformApiKeysRouter);

/* INSTANCE / FS (auth + rate limit — infrastructure access) */
router.use("/instance", requireFirebaseAuth, rateLimit, InstanceRouter);
router.use("/terminal", requireFirebaseAuth, rateLimit, terminalRouter);
router.use("/fs", requireFirebaseAuth, rateLimit, fsRouter);


/* ROOT */
router.get("/", (_req, res) => {
  res.json({
    ok: true,
    engine: "YUA-Core",
    status: "running",
    timestamp: new Date().toISOString(),
  });
});

export default router;
