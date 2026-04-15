// src/routes/yuan-agent-router.ts
// YUAN Coding Agent API Router (SSOT)
//
// Phase 1:
// POST /api/yuan-agent/run      -> Start agent execution (returns sessionId)
// GET  /api/yuan-agent/stream   -> SSE streaming (realtime events)
// POST /api/yuan-agent/approve  -> Approval response (approve/reject)
// GET  /api/yuan-agent/sessions -> Session list
// POST /api/yuan-agent/stop     -> Stop agent
// GET  /api/yuan-agent/session/:id -> Session detail
//
// Phase 2:
// POST /api/yuan-agent/interrupt       -> Interrupt running session (soft/hard/pause/resume)
// GET  /api/yuan-agent/status          -> Detailed session status
// POST /api/yuan-agent/team/join       -> Join session as observer (WebSocket upgrade)
// POST /api/yuan-agent/team/feedback   -> Inject feedback into running session
// GET  /api/yuan-agent/team/members    -> List current session observers

import { Router, Request, Response } from "express";
import path from "path";
import {
  AgentSessionManager,
  type AgentEvent,
  type AgentSessionStatus,
} from "../agent/agent-session-manager";
import { AgentExecutor } from "../agent/agent-executor";
import { SubscriptionRepo } from "../db/repositories/subscription-repo";
import { pgPool } from "../db/postgres";

const router = Router();

/* ==================================================
   Phase 2 — Rate limit state (in-memory, per-process)
================================================== */
const interruptRateMap = new Map<string, { count: number; resetAt: number }>();

/** Check interrupt rate limit: max 10 per minute per user */
function checkInterruptRateLimit(userId: string | number): boolean {
  const key = String(userId);
  const now = Date.now();
  const entry = interruptRateMap.get(key);
  if (!entry || now >= entry.resetAt) {
    interruptRateMap.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= 10) return false;
  entry.count++;
  return true;
}

/** Track active WebSocket observers per session */
const sessionObservers = new Map<
  string,
  Set<{ userId: string | number; name: string; role: string; joinedAt: number; ws: any }>
>();

/* ==================================================
   POST /run — Start agent execution
================================================== */
router.post("/run", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    const workspaceId = req.workspace?.id;

    if (!userId || !workspaceId) {
      res.status(401).json({ ok: false, error: "auth_required" });
      return;
    }

    const { prompt, workDir, model, provider, maxIterations } = req.body ?? {};

    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      res.status(400).json({ ok: false, error: "prompt is required" });
      return;
    }

    // I-prompt-length: Reject oversized prompts
    if (prompt.length > 50_000) {
      res.status(400).json({ ok: false, error: "prompt_too_long", message: "Maximum 50,000 characters" });
      return;
    }

    // C10: Resolve subscription plan from DB (req.subscription is never populated for this route)
    const sub = await SubscriptionRepo.getByUserId(String(userId));
    const plan = (sub?.status === "active" || sub?.status === "trial")
      ? (sub.plan ?? "free")
      : "free";
    const limits = AgentSessionManager.getPlanLimits(plan);

    // Concurrent session check
    const activeCount = AgentSessionManager.getActiveCount(userId);
    if (limits.maxConcurrent > 0 && activeCount >= limits.maxConcurrent) {
      res.status(429).json({
        ok: false,
        error: "concurrent_session_limit",
        message: `Plan "${plan}" allows max ${limits.maxConcurrent} concurrent sessions. Currently active: ${activeCount}`,
      });
      return;
    }

    // I-daily-quota: Enforce daily run quota
    const dailyCount = AgentSessionManager.getDailyRunCount(userId);
    if (limits.dailyRuns > 0 && dailyCount >= limits.dailyRuns) {
      res.status(429).json({
        ok: false,
        error: "daily_run_limit",
        message: `Plan "${plan}" allows max ${limits.dailyRuns} runs per day. Used today: ${dailyCount}`,
      });
      return;
    }

    // C11: Validate workDir to prevent path traversal
    let sanitizedWorkDir: string | undefined;
    if (typeof workDir === "string" && workDir.length > 0) {
      const resolved = path.resolve(workDir);
      const allowedBase = "/var/yuan-sessions/";
      const tmpBase = "/tmp/yuan-agent/";
      if (!resolved.startsWith(allowedBase) && !resolved.startsWith(tmpBase)) {
        res.status(400).json({ ok: false, error: "invalid_work_directory" });
        return;
      }
      sanitizedWorkDir = resolved;
    }

    // Create session
    const session = AgentSessionManager.createSession({
      userId,
      workspaceId,
      prompt: prompt.trim(),
      model: typeof model === "string" ? model : undefined,
      provider: typeof provider === "string" ? provider : undefined,
      workDir: sanitizedWorkDir,
      maxIterations:
        typeof maxIterations === "number"
          ? Math.min(maxIterations, limits.maxIterations)
          : limits.maxIterations,
    });

    // Start agent loop asynchronously (non-blocking)
    setImmediate(() => {
      const executor = new AgentExecutor({
        sessionId: session.id,
        prompt: prompt.trim(),
        model: session.model,
        provider: session.provider,
        workDir: session.workDir,
        planLimits: {
          maxIterations: session.maxIterations,
        },
      });

      // Listen for interrupt signals from session manager
      const sessionObj = AgentSessionManager.getSession(session.id);
      if (sessionObj) {
        sessionObj.emitter.on("stop", () => executor.interrupt("hard"));
      }

      executor.run().catch((err) => {
        console.error("[YUAN_AGENT] Executor fatal error:", err);
        AgentSessionManager.updateStatus(session.id, "failed", String(err));
      });
    });

    res.status(200).json({
      ok: true,
      sessionId: session.id,
      runId: session.runId,
      status: "started" as const,
      streamUrl: `/api/yuan-agent/stream?sessionId=${session.id}`,
    });
  } catch (err: any) {
    console.error("[YUAN_AGENT] /run error:", err);
    res.status(500).json({
      ok: false,
      error: "internal_error",
      message: err?.message ?? "Failed to start agent",
    });
  }
});

/* ==================================================
   GET /stream?sessionId=<id> — SSE streaming
================================================== */
router.get("/stream", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId;

  if (typeof sessionId !== "string" || !sessionId) {
    res.status(400).json({ ok: false, error: "sessionId required" });
    return;
  }

  const session = AgentSessionManager.getSession(sessionId);
  if (!session) {
    res.status(404).json({ ok: false, error: "session_not_found" });
    return;
  }

  // Verify ownership
  const userId = req.user?.userId;
  if (session.userId !== userId) {
    res.status(403).json({ ok: false, error: "forbidden" });
    return;
  }

  /* ---------- SSE Headers ---------- */
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write(Buffer.from(`: yuan-agent-stream-start\n\n`, "utf-8"));

  /* ---------- Replay buffered events ---------- */
  const lastEventId = req.headers["last-event-id"];
  const replayFrom =
    typeof lastEventId === "string" ? parseInt(lastEventId, 10) : 0;

  for (const buffered of session.eventBuffer) {
    if (buffered.seq <= replayFrom) continue;
    const sseFrame = `id: ${buffered.seq}\nevent: ${buffered.kind}\ndata: ${JSON.stringify(buffered)}\n\n`;
    res.write(Buffer.from(sseFrame, "utf-8"));
  }

  /* ---------- Keep alive ---------- */
  const keepAlive = setInterval(() => {
    try {
      res.write(Buffer.from(`: ping ${Date.now()}\n\n`, "utf-8"));
    } catch {
      /* ignore */
    }
  }, 15000);

  /* ---------- Cleanup ---------- */
  let closed = false;

  const cleanup = (reason: string) => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    session.emitter.removeListener("event", onEvent);
    try {
      res.end();
    } catch {
      /* ignore */
    }
    console.log("[YUAN_AGENT][SSE] Closed:", { sessionId, reason });
  };

  res.on("close", () => cleanup("client_close"));
  res.on("error", () => cleanup("response_error"));

  /* ---------- Subscribe to live events ---------- */
  const onEvent = (event: AgentEvent & { seq?: number }) => {
    if (closed) return;
    const eventSeq = event.seq ?? session.eventSeqCounter;
    try {
      const sseFrame = `id: ${eventSeq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
      res.write(Buffer.from(sseFrame, "utf-8"));

      // Close stream on terminal events
      if (event.kind === "agent:done") {
        cleanup("done");
      }
    } catch {
      cleanup("write_error");
    }
  };

  session.emitter.on("event", onEvent);

  // If session already in terminal state, send done and close
  const terminalStates: AgentSessionStatus[] = ["completed", "failed", "stopped"];
  if (terminalStates.includes(session.status)) {
    const terminalSeq = session.eventSeqCounter + 1;
    const doneEvent: AgentEvent & { seq: number } = {
      kind: "agent:done",
      sessionId,
      runId: session.runId,
      timestamp: Date.now(),
      data: { status: session.status, error: session.error },
      seq: terminalSeq,
    };
    const sseFrame = `id: ${terminalSeq}\nevent: ${doneEvent.kind}\ndata: ${JSON.stringify(doneEvent)}\n\n`;
    res.write(Buffer.from(sseFrame, "utf-8"));
    cleanup("already_terminal");
  }
});

/* ==================================================
   POST /approve — Approval response
================================================== */
router.post("/approve", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ ok: false, error: "auth_required" });
      return;
    }

    const { sessionId, actionId, response } = req.body ?? {};

    if (!sessionId || typeof sessionId !== "string") {
      res.status(400).json({ ok: false, error: "sessionId is required" });
      return;
    }
    if (!actionId || typeof actionId !== "string") {
      res.status(400).json({ ok: false, error: "actionId is required" });
      return;
    }

    const validResponses = ["approve", "reject", "always_approve"] as const;
    if (!response || !validResponses.includes(response)) {
      res.status(400).json({
        ok: false,
        error: `response must be one of: ${validResponses.join(", ")}`,
      });
      return;
    }

    const session = AgentSessionManager.getSession(sessionId);
    if (!session) {
      res.status(404).json({ ok: false, error: "session_not_found" });
      return;
    }

    // Verify ownership
    if (session.userId !== userId) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }

    const resolved = AgentSessionManager.resolveApproval(
      sessionId,
      actionId,
      response as "approve" | "reject" | "always_approve"
    );

    if (!resolved) {
      res.status(409).json({
        ok: false,
        error: "no_pending_approval",
        message: "No pending approval matching the given actionId",
      });
      return;
    }

    res.status(200).json({
      ok: true,
      sessionId,
      actionId,
      response,
    });
  } catch (err: any) {
    console.error("[YUAN_AGENT] /approve error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

/* ==================================================
   GET /sessions — List user sessions
================================================== */
router.get("/sessions", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ ok: false, error: "auth_required" });
      return;
    }

    const sessions = AgentSessionManager.listSessions(userId);
    const serialized = sessions.map((s) =>
      AgentSessionManager.serializeSession(s)
    );

    res.status(200).json({
      ok: true,
      sessions: serialized,
      count: serialized.length,
    });
  } catch (err: any) {
    console.error("[YUAN_AGENT] /sessions error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

/* ==================================================
   GET /session/:id — Session detail
================================================== */
router.get("/session/:id", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ ok: false, error: "auth_required" });
      return;
    }

    const session = AgentSessionManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ ok: false, error: "session_not_found" });
      return;
    }

    if (session.userId !== userId) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }

    res.status(200).json({
      ok: true,
      session: AgentSessionManager.serializeSession(session),
    });
  } catch (err: any) {
    console.error("[YUAN_AGENT] /session/:id error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

/* ==================================================
   POST /stop — Stop agent execution
================================================== */
router.post("/stop", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ ok: false, error: "auth_required" });
      return;
    }

    const { sessionId } = req.body ?? {};
    if (!sessionId || typeof sessionId !== "string") {
      res.status(400).json({ ok: false, error: "sessionId is required" });
      return;
    }

    const session = AgentSessionManager.getSession(sessionId);
    if (!session) {
      res.status(404).json({ ok: false, error: "session_not_found" });
      return;
    }

    if (session.userId !== userId) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }

    const stopped = AgentSessionManager.stopSession(sessionId);
    if (!stopped) {
      res.status(409).json({
        ok: false,
        error: "session_not_active",
        message: `Session is in "${session.status}" state and cannot be stopped`,
      });
      return;
    }

    res.status(200).json({
      ok: true,
      sessionId,
      status: "stopped",
    });
  } catch (err: any) {
    console.error("[YUAN_AGENT] /stop error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

/* ==================================================
   Phase 2 Endpoints
================================================== */

/* ==================================================
   POST /interrupt — Interrupt a running agent session
   Types: soft | hard | pause | resume
================================================== */
router.post("/interrupt", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ ok: false, error: "auth_required" });
      return;
    }

    // Rate limit: max 10 interrupts per minute
    if (!checkInterruptRateLimit(userId)) {
      res.status(429).json({
        ok: false,
        error: "rate_limit_exceeded",
        message: "Maximum 10 interrupt requests per minute",
      });
      return;
    }

    const { sessionId, type, feedback } = req.body ?? {};

    if (!sessionId || typeof sessionId !== "string") {
      res.status(400).json({ ok: false, error: "sessionId is required" });
      return;
    }

    const validTypes = ["soft", "hard", "pause", "resume"] as const;
    if (!type || !validTypes.includes(type)) {
      res.status(400).json({
        ok: false,
        error: `type must be one of: ${validTypes.join(", ")}`,
      });
      return;
    }

    // Validate feedback length
    if (feedback !== undefined && feedback !== null) {
      if (typeof feedback !== "string" || feedback.length > 5000) {
        res.status(400).json({
          ok: false,
          error: "feedback must be a string with max 5000 characters",
        });
        return;
      }
    }

    const session = AgentSessionManager.getSession(sessionId);
    if (!session) {
      res.status(404).json({ ok: false, error: "session_not_found" });
      return;
    }

    // Verify ownership
    if (session.userId !== userId) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }

    switch (type) {
      case "soft": {
        // Cancel current tool, inject feedback, continue loop
        AgentSessionManager.emitEvent(sessionId, {
          kind: "agent:interrupt",
          runId: session.runId,
          data: { type: "soft", feedback: feedback ?? null },
        });
        // If there's feedback, inject it as a user message for the next iteration
        if (feedback) {
          AgentSessionManager.injectFeedback(sessionId, feedback, userId);
        }
        break;
      }
      case "hard": {
        // Stop all execution, emergency checkpoint, pause session
        AgentSessionManager.emitEvent(sessionId, {
          kind: "agent:interrupt",
          runId: session.runId,
          data: { type: "hard", feedback: feedback ?? null },
        });
        AgentSessionManager.stopSession(sessionId);
        break;
      }
      case "pause": {
        AgentSessionManager.updateStatus(sessionId, "paused");
        AgentSessionManager.emitEvent(sessionId, {
          kind: "agent:interrupt",
          runId: session.runId,
          data: { type: "pause" },
        });
        break;
      }
      case "resume": {
        if (session.status !== "paused") {
          res.status(409).json({
            ok: false,
            error: "session_not_paused",
            message: `Session is in "${session.status}" state, cannot resume`,
          });
          return;
        }
        AgentSessionManager.updateStatus(sessionId, "running");
        AgentSessionManager.emitEvent(sessionId, {
          kind: "agent:interrupt",
          runId: session.runId,
          data: { type: "resume" },
        });
        break;
      }
    }

    res.status(200).json({ ok: true });
  } catch (err: any) {
    console.error("[YUAN_AGENT] /interrupt error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

/* ==================================================
   GET /status?sessionId=<id> — Detailed session status
================================================== */
router.get("/status", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ ok: false, error: "auth_required" });
      return;
    }

    const sessionId = req.query.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      res.status(400).json({ ok: false, error: "sessionId required" });
      return;
    }

    const session = AgentSessionManager.getSession(sessionId);
    if (!session) {
      res.status(404).json({ ok: false, error: "session_not_found" });
      return;
    }

    // Verify ownership
    if (session.userId !== userId) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }

    // Resolve plan limits
    const sub = await SubscriptionRepo.getByUserId(String(userId));
    const plan =
      sub?.status === "active" || sub?.status === "trial"
        ? (sub.plan ?? "free")
        : "free";
    const limits = AgentSessionManager.getPlanLimits(plan);

    // Compute token usage from session
    const sessionTokensUsed = (session.tokenUsage?.input ?? 0) + (session.tokenUsage?.output ?? 0);
    const sessionTokensMax = 200_000; // default context window

    // Daily run usage
    const dailyUsed = AgentSessionManager.getDailyRunCount(userId);
    const dailyMax = limits.dailyRuns;

    // Rate limit window (5-hour window)
    const windowHours = 5;
    const sessionAge = (Date.now() - session.createdAt) / (1000 * 60 * 60);
    const usedHours = Math.min(sessionAge, windowHours);
    const remainingHours = Math.max(0, windowHours - usedHours);

    // Context window usage (approximation from token usage)
    const contextUsed = sessionTokensUsed;
    const contextMax = sessionTokensMax;

    // Iteration info
    const currentIteration = session.iterations ?? 0;
    const maxIterations = session.maxIterations ?? limits.maxIterations;

    // Duration in ms
    const duration = Date.now() - session.createdAt;

    // Files changed (tracked externally, default 0)
    const filesChanged = 0;

    // Agent progress (sub-agents if any, empty for single-agent mode)
    const agents: unknown[] = [];

    res.status(200).json({
      ok: true,
      sessionId,
      status: session.status,
      tokens: {
        session: { used: sessionTokensUsed, max: sessionTokensMax },
        daily: { used: dailyUsed, max: dailyMax },
      },
      rateLimit: {
        windowHours,
        usedHours: Math.round(usedHours * 100) / 100,
        remainingHours: Math.round(remainingHours * 100) / 100,
      },
      runs: {
        daily: { used: dailyUsed, max: dailyMax },
      },
      context: {
        usedTokens: contextUsed,
        maxTokens: contextMax,
      },
      agents,
      duration,
      filesChanged,
      iterations: {
        current: currentIteration,
        max: maxIterations,
      },
    });
  } catch (err: any) {
    console.error("[YUAN_AGENT] /status error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

/* ==================================================
   POST /team/join?sessionId=<id> — Join session as observer
   Expects WebSocket upgrade via `ws` library
================================================== */
router.post("/team/join", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    const workspaceId = req.workspace?.id;
    if (!userId || !workspaceId) {
      res.status(401).json({ ok: false, error: "auth_required" });
      return;
    }

    const sessionId = req.query.sessionId as string;
    if (!sessionId) {
      res.status(400).json({ ok: false, error: "sessionId required" });
      return;
    }

    const session = AgentSessionManager.getSession(sessionId);
    if (!session) {
      res.status(404).json({ ok: false, error: "session_not_found" });
      return;
    }

    // Require same workspace membership (not necessarily owner)
    if (session.workspaceId !== workspaceId) {
      res.status(403).json({
        ok: false,
        error: "forbidden",
        message: "You must be in the same workspace to observe this session",
      });
      return;
    }

    // Check workspace membership in DB
    const memberCheck = await pgPool.query(
      `SELECT role FROM workspace_users WHERE workspace_id = $1 AND user_id = $2 LIMIT 1`,
      [workspaceId, userId]
    );
    if (memberCheck.rows.length === 0) {
      res.status(403).json({ ok: false, error: "not_workspace_member" });
      return;
    }

    const memberRole = memberCheck.rows[0].role as string;

    // Register observer intent — actual WebSocket upgrade happens at server level
    // This endpoint validates auth and returns a join token
    const joinToken = `join_${sessionId}_${userId}_${Date.now()}`;

    // Initialize observer set for this session if needed
    if (!sessionObservers.has(sessionId)) {
      sessionObservers.set(sessionId, new Set());
    }

    // Subscribe to session events via Redis Pub/Sub for cross-process support
    let redisSub: any = null;
    try {
      const ioredis = await import("ioredis");
      const RedisClass = ioredis.default ?? ioredis;
      redisSub = new (RedisClass as any)({
        host: "127.0.0.1",
        port: 6379,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
      });
      await redisSub.connect();
      await redisSub.subscribe(`yuan:session:${sessionId}`);

      // Redis subscription is ready — clean up will happen on WS close
      // Store the subscriber reference for cleanup
      redisSub.on("message", (_channel: string, message: string) => {
        // Forward to all WebSocket observers for this session
        const observers = sessionObservers.get(sessionId);
        if (observers) {
          for (const obs of observers) {
            try {
              obs.ws?.send(message);
            } catch {
              /* observer disconnected */
            }
          }
        }
      });
    } catch {
      // Redis not available — fall back to in-process only
      redisSub = null;
    }

    res.status(200).json({
      ok: true,
      joinToken,
      sessionId,
      role: memberRole,
      wsUrl: `/api/yuan-agent/team/ws?sessionId=${sessionId}&token=${joinToken}`,
      message: "Use the wsUrl to upgrade to WebSocket connection",
      _redisSub: redisSub ? "connected" : "unavailable (in-process fallback)",
    });
  } catch (err: any) {
    console.error("[YUAN_AGENT] /team/join error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

/* ==================================================
   POST /team/feedback — Inject feedback into running session
================================================== */
router.post("/team/feedback", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ ok: false, error: "auth_required" });
      return;
    }

    const { sessionId, message, targetAgentId } = req.body ?? {};

    if (!sessionId || typeof sessionId !== "string") {
      res.status(400).json({ ok: false, error: "sessionId is required" });
      return;
    }

    if (!message || typeof message !== "string") {
      res.status(400).json({ ok: false, error: "message is required" });
      return;
    }

    // Validate feedback length: max 5000 chars
    if (message.length > 5000) {
      res.status(400).json({
        ok: false,
        error: "message_too_long",
        message: "Feedback message must be at most 5000 characters",
      });
      return;
    }

    const session = AgentSessionManager.getSession(sessionId);
    if (!session) {
      res.status(404).json({ ok: false, error: "session_not_found" });
      return;
    }

    // Verify ownership or same workspace
    const workspaceId = req.workspace?.id;
    if (session.userId !== userId) {
      // Allow workspace members to give feedback
      if (!workspaceId || session.workspaceId !== workspaceId) {
        res.status(403).json({ ok: false, error: "forbidden" });
        return;
      }
      // Verify workspace membership
      const memberCheck = await pgPool.query(
        `SELECT role FROM workspace_users WHERE workspace_id = $1 AND user_id = $2 LIMIT 1`,
        [workspaceId, userId]
      );
      if (memberCheck.rows.length === 0) {
        res.status(403).json({ ok: false, error: "not_workspace_member" });
        return;
      }
    }

    // Inject feedback into the session
    AgentSessionManager.injectFeedback(sessionId, message, userId, targetAgentId);

    // Emit feedback event for observers
    AgentSessionManager.emitEvent(sessionId, {
      kind: "agent:feedback",
      runId: session.runId,
      data: {
        userId,
        message,
        targetAgentId: targetAgentId ?? null,
        timestamp: Date.now(),
      },
    });

    res.status(200).json({ ok: true });
  } catch (err: any) {
    console.error("[YUAN_AGENT] /team/feedback error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

/* ==================================================
   GET /team/members?sessionId=<id> — List current observers
================================================== */
router.get("/team/members", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ ok: false, error: "auth_required" });
      return;
    }

    const sessionId = req.query.sessionId as string;
    if (!sessionId) {
      res.status(400).json({ ok: false, error: "sessionId required" });
      return;
    }

    const session = AgentSessionManager.getSession(sessionId);
    if (!session) {
      res.status(404).json({ ok: false, error: "session_not_found" });
      return;
    }

    // Verify ownership or same workspace
    const workspaceId = req.workspace?.id;
    if (session.userId !== userId) {
      if (!workspaceId || session.workspaceId !== workspaceId) {
        res.status(403).json({ ok: false, error: "forbidden" });
        return;
      }
    }

    // Get observers from in-memory map
    const observers = sessionObservers.get(sessionId);
    const members: Array<{
      userId: string | number;
      name: string;
      role: string;
      joinedAt: number;
    }> = [];

    // Always include session owner
    members.push({
      userId: session.userId,
      name: "Owner",
      role: "owner",
      joinedAt: session.createdAt,
    });

    if (observers) {
      for (const obs of observers) {
        members.push({
          userId: obs.userId,
          name: obs.name,
          role: obs.role,
          joinedAt: obs.joinedAt,
        });
      }
    }

    res.status(200).json({
      ok: true,
      sessionId,
      members,
      count: members.length,
    });
  } catch (err: any) {
    console.error("[YUAN_AGENT] /team/members error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

export default router;
