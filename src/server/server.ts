// 📂 src/server/server.ts
// 🔥 YA-ENGINE SERVER — SSE SAFE FINAL (2025.12)

import "express-async-errors";

import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";

/* ---------------------------------------------------------
 * DB
 * ------------------------------------------------------- */
import "../db/firebase";
import "../db/mysql";
import { initializePostgres } from "../db/postgres";

/* ---------------------------------------------------------
 * ROUTERS
 * ------------------------------------------------------- */
import router from "../routes";
import healthRouter from "../routes/health-router";
import streamRouter from "../routes/stream-router";

import { AiGateway } from "./api-gateway";

/* ---------------------------------------------------------
 * DOCS / LOG
 * ------------------------------------------------------- */
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "../docs/swagger-loader";
import { log, logError } from "../utils/logger";
import "../ai/judgment/judgment-singletons";
import { loadJudgmentRules } from "../ai/judgment/judgment-persistence";
import { assetErrorHandler } from "../api/middleware/asset-error-handler";
import http from "http";
import { attachVoiceWebSocket } from "./voice-ws";
import { attachWorkspaceDocsWebSocket } from "./workspace-docs-ws";
const app = express();

/* ---------------------------------------------------------
 * 🔥 FIX 0: proxy 환경 신뢰 (Next.js rewrite 필수)
 * ------------------------------------------------------- */
app.set("trust proxy", true);
app.use(cookieParser());

// 🔒 만료 세션 정리 크론 (6시간마다 — 세션 유효기간 7일, DB 정리 주기)
import { AuthSessionRepo } from "../db/repo/auth-session.repo";
setInterval(async () => {
  try {
    const count = await AuthSessionRepo.deleteExpired();
    if (count > 0) console.log(`[AUTH_SESSION_CLEANUP] Deleted ${count} expired sessions`);
  } catch (e) { console.warn("[AUTH_SESSION_CLEANUP] Error:", e); }
}, 6 * 60 * 60 * 1000);

/* ---------------------------------------------------------
 * 🔥 FIX 1: ETag 완전 비활성화 (SSE buffering 원인)
 * ------------------------------------------------------- */
app.disable("etag");

/* ---------------------------------------------------------
 * SECURITY
 * ------------------------------------------------------- */
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
  })
);

app.use(
  cors({
    origin: [
      "https://yuaone.com",
      "https://www.yuaone.com",
      "https://platform.yuaone.com",
      "https://admin.yuaone.com",
      "http://localhost:3000",
      "http://localhost:3100",
      "http://localhost:5173",
      "http://localhost:5174",
      "http://34.50.27.221:5173",
      "http://34.50.27.221:5174",
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  })
);

/* ---------------------------------------------------------
 * 🔥 FIX 2: SSE 전역 버퍼링 차단 (proxy / nginx / dev-server)
 * ------------------------------------------------------- */
app.use((req, res, next) => {
  res.setHeader("X-Accel-Buffering", "no");
  next();
});

/* ---------------------------------------------------------
 * PARSER / LOGGER
 * ------------------------------------------------------- */
/**
 * ⚠️ body parser는 SSE GET 요청에 영향 없음
 *     (POST /api/chat 이후 GET /stream 이므로 안전)
 */
// LS webhook needs raw body for HMAC verification. Skip JSON parser for that exact path.
app.use((req, res, next) => {
  if (req.path === "/api/billing/webhook/lemonsqueezy") return next();
  return express.json({ limit: "20mb" })(req, res, next);
});
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));

/* ---------------------------------------------------------
 * DB INIT
 * ------------------------------------------------------- */
initializePostgres()
  .then(() => log("🟢 PostgreSQL Initialized"))
  .catch((err) => logError("❌ PostgreSQL Init Error", err));

/* ---------------------------------------------------------
 * 🔒 JUDGMENT RULE LOAD (ON BOOT, SSOT)
 * ------------------------------------------------------- */
loadJudgmentRules();
log("🧠 Judgment Rules Loaded");

/* ---------------------------------------------------------
 * DOCS — Swagger UI moved from /api/docs to /api/swagger-ui
 * 2026-04-11 to free /api/docs/* for the frontend content loader
 * (app/api/docs/[...path]/route.ts serves monorepo /docs/*.md).
 * ------------------------------------------------------- */
app.use("/api/swagger-ui", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get("/api/swagger-ui.json", (_req, res) => res.json(swaggerSpec));

/* ---------------------------------------------------------
 * AI GATEWAY (JSON)
 * ------------------------------------------------------- */
app.post("/api/yua", (req, res) => {
  return AiGateway.handle(req, res);
});

/* ---------------------------------------------------------
 * HEALTH
 * ------------------------------------------------------- */
app.use("/api/health", healthRouter);

/* ---------------------------------------------------------
 * 🔥 SSE ROUTES (반드시 JSON router 보다 먼저)
 * ------------------------------------------------------- */

/* Legacy / SSOT / Alias — 전부 유지 */
app.use("/api/stream", streamRouter);
app.use("/api/chat/stream", streamRouter);

app.use("/chat/stream", streamRouter);
app.use("/stream", streamRouter);

/* ---------------------------------------------------------
 * JSON APIs
 * ------------------------------------------------------- */
app.use("/api", router);

/* ---------------------------------------------------------
 * ASSET DOMAIN ERROR (🔥 반드시 404 이전)
 * ------------------------------------------------------- */
app.use(assetErrorHandler);

/* ---------------------------------------------------------
 * 404
 * ------------------------------------------------------- */
app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    message: "Endpoint Not Found",
  });
});

/* ---------------------------------------------------------
 * GLOBAL ERROR
 * ------------------------------------------------------- */
app.use((err: any, _req: any, res: any, _next: any) => {
  logError("🔥 Global Error", err);
  res.status(500).json({
    ok: false,
    error: err?.message ?? "Internal Server Error",
  });
});

/* ---------------------------------------------------------
 * START
 * ------------------------------------------------------- */
const PORT = 4000;

const server = http.createServer(app);

attachVoiceWebSocket(server);
attachWorkspaceDocsWebSocket(server);

server.listen(PORT, "0.0.0.0", async () => {
  log(`🚀 YUA-ENGINE LIVE on http://0.0.0.0:${PORT}`);
  log("🎙 Voice WebSocket attached");
  log("📝 Workspace Docs WebSocket attached");

  // MoP Redis cache wiring
  try {
    const { redisPub } = await import("../db/redis.js");
    const { setRedisClient } = await import("../ai/mop/mop-gate.js");
    setRedisClient(
      (key) => redisPub.get(key),
      (key, val, mode, ttl) => redisPub.set(key, val, mode as any, ttl),
    );
    log("🧠 MoP Redis cache connected");
  } catch (e) {
    console.warn("[MOP] Redis wiring failed:", (e as Error).message);
  }
});

export default app;
