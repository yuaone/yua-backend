import { Router, Request, Response } from "express";
import { StreamEngine } from "../ai/engines/stream-engine";
import { ThreadEngine } from "../ai/engines/thread.engine";
import { StreamStage } from "yua-shared/stream/stream-stage";
import { requireAuthOrApiKey } from "../auth/auth-or-apikey";
import { withWorkspace } from "../middleware/with-workspace";

const router = Router();

/**
 * POST /api/stream/abort
 * body: { threadId: number }
 */
router.post(
  "/abort",
  requireAuthOrApiKey("yua"),
  withWorkspace,
  async (req: Request, res: Response) => {
    const threadId = Number(req.body?.threadId);
    const userId = Number(req.user?.id ?? req.user?.userId);
    const workspaceId = req.workspace?.id;

    if (!Number.isFinite(threadId)) {
      res.status(400).json({
        ok: false,
        error: "threadId_required",
      });
      return;
    }
    if (!Number.isFinite(userId) || !workspaceId) {
      res.status(401).json({ ok: false, error: "auth_required" });
      return;
    }

    const canWrite = await ThreadEngine.canWrite({ threadId, userId, workspaceId });
    if (!canWrite) {
      res.status(403).json({ ok: false, error: "thread_access_denied" });
      return;
    }

    try {
      const aborted = StreamEngine.abort(threadId);

      res.status(200).json({
        ok: true,
        aborted: Boolean(aborted),
        threadId,
      });
      return;
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: "abort_failed",
      });
      return;
    }
  }
);

/**
 * POST /api/chat/stream/unlock
 * body: { threadId: number, traceId?: string }
 */
router.post(
  "/unlock",
  requireAuthOrApiKey("yua"),
  withWorkspace,
  async (req: Request, res: Response) => {
    const threadId = Number(req.body?.threadId);
    const userId = Number(req.user?.id ?? req.user?.userId);
    const workspaceId = req.workspace?.id;
    if (!Number.isFinite(threadId)) {
      res.status(400).json({ ok: false, error: "threadId_required" });
      return;
    }
    if (!Number.isFinite(userId) || !workspaceId) {
      res.status(401).json({ ok: false, error: "auth_required" });
      return;
    }

    const canWrite = await ThreadEngine.canWrite({ threadId, userId, workspaceId });
    if (!canWrite) {
      res.status(403).json({ ok: false, error: "thread_access_denied" });
      return;
    }

    const traceId =
      typeof req.body?.traceId === "string"
        ? req.body.traceId
        : StreamEngine.getSession(threadId)?.traceId;

    if (!traceId) {
      res.status(400).json({ ok: false, error: "traceId_required" });
      return;
    }

    try {
      await StreamEngine.publish(threadId, {
        event: "stage",
        stage: StreamStage.ANSWER_UNLOCKED,
        traceId,
      });
      res.status(200).json({ ok: true, threadId, traceId });
      return;
    } catch (err) {
      res.status(500).json({ ok: false, error: "unlock_failed" });
      return;
    }
  }
);

export default router;
