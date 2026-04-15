import dotenv from "dotenv";
import path from "path";

dotenv.config({
  path: path.resolve(__dirname, "../../.env"),
});

import os from "os";
import {
  claimNextSupportAutoReplyJob,
  completeSupportAutoReplyJob,
  failSupportAutoReplyJob,
  getSupportTicketReplyContext,
  recordSupportEmailDelivery,
  saveSupportAutoReplyMessage,
} from "../support-ai/support-auto-reply-queue";
import { SupportAIEngine } from "../support-ai/support-ai-engine";
import { sendSupportAutoReplyEmail } from "../services/support-email.service";
import { log, logError } from "../utils/logger";

const POLL_MS = Math.max(200, Number(process.env.SUPPORT_JOB_POLL_MS ?? "1000"));
const workerId = `${os.hostname()}-${process.pid}`;
const backoffSeconds = [15, 30, 60];

let isRunning = true;
let isTicking = false;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processOne() {
  const job = await claimNextSupportAutoReplyJob(workerId);
  if (!job) return false;

  try {
    const ctx = await getSupportTicketReplyContext(job.ticket_id);
    if (!ctx) throw new Error("ticket_not_found");
    if (!ctx.reporterEmail) throw new Error("recipient_email_missing");

    const draft = await SupportAIEngine.generateDraft(job.ticket_id);
    if (!draft.ok || !draft.draft) {
      throw new Error("ai_draft_generation_failed");
    }

    const mailResult = await sendSupportAutoReplyEmail({
      toEmail: ctx.reporterEmail,
      ticketId: ctx.ticketId,
      subject: ctx.subject,
      bodyText: draft.draft,
    });
    if (!mailResult.ok) {
      await recordSupportEmailDelivery({
        ticketId: job.ticket_id,
        jobId: job.id,
        recipientEmail: ctx.reporterEmail,
        status: "failed",
        errorMessage: mailResult.error ?? "mail_send_failed",
      });
      throw new Error(`mail_send_failed:${mailResult.error ?? "unknown"}`);
    }

    await recordSupportEmailDelivery({
      ticketId: job.ticket_id,
      jobId: job.id,
      recipientEmail: ctx.reporterEmail,
      status: "sent",
      providerMessageId: mailResult.messageId ?? null,
    });

    await saveSupportAutoReplyMessage({
      ticketId: job.ticket_id,
      content: draft.draft,
    });

    await completeSupportAutoReplyJob(job.id);
    log(`[SupportAutoReplyWorker] completed job=${job.id} ticket=${job.ticket_id}`);
  } catch (e: any) {
    const message = String(e?.message ?? "unknown_error");
    const retryDelay = backoffSeconds[Math.max(0, Math.min(job.attempts - 1, backoffSeconds.length - 1))] ?? 60;
    try {
      await failSupportAutoReplyJob({
        jobId: job.id,
        attempts: job.attempts,
        maxAttempts: job.max_attempts,
        error: message,
        retryDelaySeconds: retryDelay,
      });
    } catch (markErr: any) {
      logError(`[SupportAutoReplyWorker] mark-failure failed job=${job.id} error=${String(markErr?.message ?? markErr)}`);
    }
    logError(`[SupportAutoReplyWorker] failed job=${job.id} ticket=${job.ticket_id} error=${message}`);
  }

  return true;
}

async function tick() {
  if (isTicking || !isRunning) return;
  isTicking = true;
  try {
    const hadWork = await processOne();
    if (!hadWork) await sleep(POLL_MS);
  } finally {
    isTicking = false;
  }
}

async function loop() {
  log(`[SupportAutoReplyWorker] started workerId=${workerId} pollMs=${POLL_MS}`);
  while (isRunning) {
    await tick();
  }
  log("[SupportAutoReplyWorker] stopped");
}

function stop() {
  isRunning = false;
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

void loop();
