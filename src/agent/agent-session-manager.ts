// src/agent/agent-session-manager.ts
// YUAN Coding Agent — Server Session Manager (SSOT)

import { randomUUID } from "crypto";
import { EventEmitter } from "events";

/* --------------------------------------------------
 * Types (inline — will migrate to yua-shared later)
 * -------------------------------------------------- */

export type AgentSessionStatus =
  | "initializing"
  | "running"
  | "waiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "stopped";

export type AgentEventKind =
  | "agent:text_delta"
  | "agent:tool_call"
  | "agent:tool_result"
  | "agent:approval_needed"
  | "agent:approval_resolved"
  | "agent:iteration_start"
  | "agent:iteration_end"
  | "agent:thinking"
  | "agent:error"
  | "agent:done"
  | "agent:status_change"
  | "agent:interrupt"
  | "agent:feedback";

export interface AgentEvent {
  kind: AgentEventKind;
  sessionId: string;
  runId: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface PendingApproval {
  actionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  risk: "low" | "medium" | "high";
  description: string;
  requestedAt: number;
}

export interface AgentSession {
  id: string;
  runId: string;
  userId: number;
  workspaceId: string;
  status: AgentSessionStatus;
  prompt: string;
  model: string;
  provider: string;
  workDir: string;
  createdAt: number;
  updatedAt: number;
  iterations: number;
  maxIterations: number;
  tokenUsage: { input: number; output: number };
  pendingApproval: PendingApproval | null;
  error: string | null;

  /** Internal event emitter — not serialized */
  emitter: EventEmitter;

  /** Event buffer for SSE reconnection */
  eventBuffer: (AgentEvent & { seq: number })[];

  /** Monotonic sequence counter for SSE events */
  eventSeqCounter: number;
}

export interface CreateSessionConfig {
  userId: number;
  workspaceId: string;
  prompt: string;
  model?: string;
  provider?: string;
  workDir?: string;
  maxIterations?: number;
}

/* --------------------------------------------------
 * Plan Limits
 * -------------------------------------------------- */

const PLAN_LIMITS: Record<string, { maxConcurrent: number; maxIterations: number; dailyRuns: number }> = {
  free:                { maxConcurrent: 1, maxIterations: 10,  dailyRuns: 5   },
  premium:             { maxConcurrent: 2, maxIterations: 50,  dailyRuns: 50  },
  developer:           { maxConcurrent: 3, maxIterations: 100, dailyRuns: 100 },
  developer_pro:       { maxConcurrent: 5, maxIterations: 200, dailyRuns: 200 },
  business:            { maxConcurrent: 5, maxIterations: 200, dailyRuns: 500 },
  business_premium:    { maxConcurrent: 10, maxIterations: 500, dailyRuns: 1000 },
  enterprise:          { maxConcurrent: 20, maxIterations: 1000, dailyRuns: -1 },
  enterprise_team:     { maxConcurrent: 20, maxIterations: 1000, dailyRuns: -1 },
  enterprise_developer:{ maxConcurrent: 20, maxIterations: 1000, dailyRuns: -1 },
};

const DEFAULT_LIMITS = PLAN_LIMITS.free;

/* --------------------------------------------------
 * Event Buffer Config
 * -------------------------------------------------- */

const MAX_EVENT_BUFFER = 500;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes after completion

/* --------------------------------------------------
 * AgentSessionManager (Singleton)
 * -------------------------------------------------- */

class AgentSessionManagerImpl {
  private sessions = new Map<string, AgentSession>();
  private userSessionIndex = new Map<number, Set<string>>();

  /* ---------- Create ---------- */

  createSession(config: CreateSessionConfig): AgentSession {
    const id = randomUUID();
    const runId = randomUUID();

    const session: AgentSession = {
      id,
      runId,
      userId: config.userId,
      workspaceId: config.workspaceId,
      status: "initializing",
      prompt: config.prompt,
      model: config.model ?? "claude-sonnet-4-20250514",
      provider: config.provider ?? "anthropic",
      workDir: config.workDir ?? `/tmp/yuan-agent/${id}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      iterations: 0,
      maxIterations: config.maxIterations ?? 100,
      tokenUsage: { input: 0, output: 0 },
      pendingApproval: null,
      error: null,
      emitter: new EventEmitter(),
      eventBuffer: [],
      eventSeqCounter: 0,
    };

    session.emitter.setMaxListeners(20);

    this.sessions.set(id, session);

    // Index by user
    let userSessions = this.userSessionIndex.get(config.userId);
    if (!userSessions) {
      userSessions = new Set();
      this.userSessionIndex.set(config.userId, userSessions);
    }
    userSessions.add(id);

    console.log("[YUAN_AGENT] Session created:", { id, userId: config.userId });
    return session;
  }

  /* ---------- Get ---------- */

  getSession(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  /* ---------- List ---------- */

  listSessions(userId: number): AgentSession[] {
    const ids = this.userSessionIndex.get(userId);
    if (!ids) return [];
    const result: AgentSession[] = [];
    for (const id of ids) {
      const s = this.sessions.get(id);
      if (s) result.push(s);
    }
    return result.sort((a, b) => b.createdAt - a.createdAt);
  }

  /* ---------- Active count ---------- */

  getActiveCount(userId: number): number {
    const ids = this.userSessionIndex.get(userId);
    if (!ids) return 0;
    let count = 0;
    for (const id of ids) {
      const s = this.sessions.get(id);
      if (s && (s.status === "running" || s.status === "waiting_approval" || s.status === "initializing")) {
        count++;
      }
    }
    return count;
  }

  /* ---------- Daily run count ---------- */

  getDailyRunCount(userId: number): number {
    const today = new Date().toISOString().slice(0, 10);
    const ids = this.userSessionIndex.get(userId);
    if (!ids) return 0;
    let count = 0;
    for (const id of ids) {
      const s = this.sessions.get(id);
      if (s && new Date(s.createdAt).toISOString().slice(0, 10) === today) {
        count++;
      }
    }
    return count;
  }

  /* ---------- Plan limits ---------- */

  getPlanLimits(plan?: string): { maxConcurrent: number; maxIterations: number; dailyRuns: number } {
    if (!plan) return DEFAULT_LIMITS;
    return PLAN_LIMITS[plan] ?? DEFAULT_LIMITS;
  }

  /* ---------- Emit event ---------- */

  emitEvent(sessionId: string, event: Omit<AgentEvent, "sessionId" | "timestamp">): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.eventSeqCounter++;
    const seq = session.eventSeqCounter;

    const fullEvent: AgentEvent & { seq: number } = {
      ...event,
      sessionId,
      timestamp: Date.now(),
      seq,
    };

    // Buffer for reconnection (seq survives buffer overflow for correct SSE replay)
    session.eventBuffer.push(fullEvent);
    if (session.eventBuffer.length > MAX_EVENT_BUFFER) {
      session.eventBuffer.shift();
    }

    session.emitter.emit("event", fullEvent);
  }

  /* ---------- Update status ---------- */

  updateStatus(sessionId: string, status: AgentSessionStatus, error?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.status = status;
    session.updatedAt = Date.now();
    if (error) session.error = error;

    this.emitEvent(sessionId, {
      kind: "agent:status_change",
      runId: session.runId,
      data: { status, error: error ?? null },
    });

    // Schedule cleanup for terminal states
    if (status === "completed" || status === "failed" || status === "stopped") {
      setTimeout(() => this.cleanupSession(sessionId), SESSION_TTL_MS);
    }
  }

  /* ---------- Approval ---------- */

  setPendingApproval(sessionId: string, approval: PendingApproval): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.pendingApproval = approval;
    session.status = "waiting_approval";
    session.updatedAt = Date.now();

    this.emitEvent(sessionId, {
      kind: "agent:approval_needed",
      runId: session.runId,
      data: { ...approval },
    });
  }

  resolveApproval(
    sessionId: string,
    actionId: string,
    response: "approve" | "reject" | "always_approve"
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.pendingApproval) return false;
    if (session.pendingApproval.actionId !== actionId) return false;

    const resolved = session.pendingApproval;
    session.pendingApproval = null;
    session.status = "running";
    session.updatedAt = Date.now();

    this.emitEvent(sessionId, {
      kind: "agent:approval_resolved",
      runId: session.runId,
      data: {
        actionId,
        toolName: resolved.toolName,
        response,
      },
    });

    // Emit on emitter so the agent loop can resume
    session.emitter.emit("approval_response", { actionId, response });
    return true;
  }

  /* ---------- Inject Feedback ---------- */

  injectFeedback(sessionId: string, message: string, userId: number, targetAgentId?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.emitEvent(sessionId, {
      kind: "agent:feedback",
      runId: session.runId,
      data: { message, userId, targetAgentId: targetAgentId ?? null },
    });

    // Let the agent loop know about the feedback
    session.emitter.emit("feedback", { message, userId, targetAgentId });
  }

  /* ---------- Stop ---------- */

  stopSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.status === "completed" || session.status === "failed" || session.status === "stopped") {
      return false;
    }

    session.emitter.emit("stop");
    this.updateStatus(sessionId, "stopped");
    return true;
  }

  /* ---------- Cleanup ---------- */

  private cleanupSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Only cleanup terminal sessions
    if (session.status !== "completed" && session.status !== "failed" && session.status !== "stopped") {
      return;
    }

    session.emitter.removeAllListeners();
    this.sessions.delete(sessionId);

    const userSessions = this.userSessionIndex.get(session.userId);
    if (userSessions) {
      userSessions.delete(sessionId);
      if (userSessions.size === 0) {
        this.userSessionIndex.delete(session.userId);
      }
    }

    console.log("[YUAN_AGENT] Session cleaned up:", sessionId);
  }

  /* ---------- Serialize (for API responses) ---------- */

  serializeSession(session: AgentSession): Record<string, unknown> {
    return {
      id: session.id,
      runId: session.runId,
      status: session.status,
      prompt: session.prompt,
      model: session.model,
      provider: session.provider,
      workDir: session.workDir,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      iterations: session.iterations,
      maxIterations: session.maxIterations,
      tokenUsage: session.tokenUsage,
      pendingApproval: session.pendingApproval,
      error: session.error,
    };
  }
}

/** Singleton */
export const AgentSessionManager = new AgentSessionManagerImpl();
