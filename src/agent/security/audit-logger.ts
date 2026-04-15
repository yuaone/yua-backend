// src/agent/security/audit-logger.ts
// YUAN Coding Agent — Audit Logger
//
// Logs all tool calls, results, and security events to PostgreSQL.
// Append-only — never delete audit records.

import { pgPool } from "../../db/postgres";

/** Audit event types */
export type AuditAction =
  | "session_start"
  | "session_end"
  | "tool_call"
  | "tool_result"
  | "approval_request"
  | "approval_response"
  | "secret_detected"
  | "path_traversal_blocked"
  | "command_blocked"
  | "interrupt"
  | "error";

export interface AuditEntry {
  sessionId: string;
  userId: number;
  action: AuditAction;
  toolName?: string;
  input?: Record<string, unknown>;
  output?: string;
  risk?: string;
  metadata?: Record<string, unknown>;
}

/**
 * AuditLogger — writes agent audit events to agent_audit_log table.
 *
 * All writes are fire-and-forget (non-blocking, non-fatal on error).
 * The table is append-only for compliance and debugging.
 */
class AuditLoggerImpl {
  private queue: AuditEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor() {
    // Flush every 5 seconds
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, 5_000);
  }

  /**
   * Log an audit event. Non-blocking — queues for batch insert.
   */
  log(entry: AuditEntry): void {
    this.queue.push(entry);

    // Flush immediately if queue is large
    if (this.queue.length >= 50) {
      void this.flush();
    }
  }

  /**
   * Convenience methods for common events.
   */
  logToolCall(sessionId: string, userId: number, toolName: string, input: Record<string, unknown>): void {
    this.log({
      sessionId,
      userId,
      action: "tool_call",
      toolName,
      input,
    });
  }

  logToolResult(sessionId: string, userId: number, toolName: string, output: string, isError: boolean): void {
    this.log({
      sessionId,
      userId,
      action: "tool_result",
      toolName,
      output: output.slice(0, 5_000), // Truncate for storage
      metadata: { isError },
    });
  }

  logSecretDetected(sessionId: string, userId: number, toolName: string, secretLabels: string[]): void {
    this.log({
      sessionId,
      userId,
      action: "secret_detected",
      toolName,
      risk: "high",
      metadata: { secretLabels },
    });
  }

  logSecurityBlock(sessionId: string, userId: number, action: "path_traversal_blocked" | "command_blocked", details: string): void {
    this.log({
      sessionId,
      userId,
      action,
      risk: "high",
      metadata: { details },
    });
  }

  logSessionStart(sessionId: string, userId: number, prompt: string, model: string): void {
    this.log({
      sessionId,
      userId,
      action: "session_start",
      metadata: { prompt: prompt.slice(0, 500), model },
    });
  }

  logSessionEnd(sessionId: string, userId: number, status: string, iterations: number): void {
    this.log({
      sessionId,
      userId,
      action: "session_end",
      metadata: { status, iterations },
    });
  }

  /**
   * Flush queued entries to the database.
   */
  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;

    const batch = this.queue.splice(0, 100);

    try {
      // Batch insert using a single query with unnest
      const values = batch.map((e, i) => {
        const offset = i * 7;
        return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`;
      });

      const params: unknown[] = [];
      for (const entry of batch) {
        params.push(
          entry.sessionId,
          entry.userId,
          entry.action,
          entry.toolName ?? null,
          entry.risk ?? null,
          JSON.stringify({
            input: entry.input,
            output: entry.output?.slice(0, 2_000),
            ...entry.metadata,
          }),
          new Date(),
        );
      }

      await pgPool.query(
        `INSERT INTO agent_audit_log
           (session_id, user_id, action, tool_name, risk, details, created_at)
         VALUES ${values.join(", ")}`,
        params,
      );
    } catch (err: unknown) {
      // Non-fatal: put entries back in queue (up to 500 max to prevent memory leak)
      if (this.queue.length < 500) {
        this.queue.unshift(...batch);
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[YUAN_AUDIT] Flush failed:", msg);
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Graceful shutdown — flush remaining entries.
   */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}

/** Singleton */
export const AuditLogger = new AuditLoggerImpl();
