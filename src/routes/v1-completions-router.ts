// 📂 src/routes/v1-completions-router.ts
// OpenAI-compatible /v1/chat/completions endpoint (SSOT wrapper)

import { Router, Request, Response } from "express";
import crypto from "crypto";
import { requireAuthOrApiKey } from "../auth/auth-or-apikey";
import { withWorkspace } from "../middleware/with-workspace";
import { ThreadEngine } from "../ai/engines/thread.engine";
import { MessageEngine } from "../ai/engines/message-engine";
import { ChatEngine } from "../ai/engines/chat-engine";
import { ExecutionEngine } from "../ai/execution/execution-engine";
import { DecisionOrchestrator } from "../ai/decision/decision-orchestrator";
import { StreamEngine } from "../ai/engines/stream-engine";
import { sanitizeUserMessage } from "../ai/utils/sanitize-user-message";
import { errorResponse } from "../utils/error-response";
import { runOpenAIRuntime } from "../ai/chat/runtime/openai-runtime";
import { pgPool } from "../db/postgres";
import type { OpenAIRuntimeEvent } from "../ai/chat/runtime/openai-runtime";
import type { Persona } from "../ai/persona/persona-context.types";
import type { YuaStreamEvent } from "../types/stream";

const router = Router();

// Model name → ChatMode SSOT mapping
const MODEL_MAP: Record<string, string> = {
  "yua-basic": "FAST",
  "yua-normal": "NORMAL",
  "yua-pro": "DEEP",
  "yua-research": "RESEARCH",
};

interface V1Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface V1Tool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface V1RequestBody {
  model?: string;
  messages: V1Message[];
  stream?: boolean;
  thread_id?: string | number;
  workspace_id?: string;
  tools?: V1Tool[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
}

/**
 * POST /v1/chat/completions
 * OpenAI-compatible chat completions endpoint.
 */
router.post(
  "/chat/completions",
  requireAuthOrApiKey("yua"),
  withWorkspace,
  async (req: Request, res: Response): Promise<Response | void> => {
    const traceId = crypto.randomUUID();
    const startTime = Date.now();

    try {
      const body = req.body as V1RequestBody;

      // --- Validate ---
      if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        return res.status(400).json({
          error: {
            message: "messages is required and must be a non-empty array",
            type: "invalid_request_error",
            code: "invalid_messages",
          },
        });
      }

      const model = body.model ?? "yua-normal";
      const stream = body.stream === true;
      const threadIdParam = body.thread_id;

      // Extract last user message
      const lastUserMsg = [...body.messages].reverse().find((m) => m.role === "user");
      if (!lastUserMsg || !lastUserMsg.content?.trim()) {
        return res.status(400).json({
          error: {
            message: "messages must contain at least one user message with content",
            type: "invalid_request_error",
            code: "no_user_message",
          },
        });
      }

      const rawUserId = req.user?.userId ?? req.user?.id;
      const userId = Number(rawUserId);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).json({
          error: {
            message: "Authentication required",
            type: "authentication_error",
            code: "auth_required",
          },
        });
      }

      const workspace = req.workspace;
      if (!workspace?.id) {
        return res.status(400).json({
          error: {
            message: "Workspace context missing",
            type: "invalid_request_error",
            code: "workspace_required",
          },
        });
      }
      const workspaceId: string = workspace.id;

      const message = sanitizeUserMessage(lastUserMsg.content);

      // --- FAST PATH: tool_calls mode (YUAN Agent, external tool use) ---
      if (body.tools && body.tools.length > 0) {
        return await handleToolCallsMode(req, res, {
          traceId,
          model,
          stream,
          message,
          messages: body.messages,
          tools: body.tools,
          toolChoice: body.tool_choice,
          userId,
          workspaceId,
        });
      }

      // --- STATELESS PATH: API key 호출 → DB 터치 없음, 로그만 ---
      const isApiKeyAuth = !!req._apiKeyAuth;
      if (isApiKeyAuth) {
        return await handleApiKeyStateless(req, res, {
          traceId,
          model,
          stream,
          message,
          messages: body.messages,
          userId,
          workspaceId,
          startTime,
        });
      }

      // --- 1. Resolve or create thread (웹/앱 유저만) ---
      let resolvedThreadId: number;
      if (threadIdParam) {
        const thread = await ThreadEngine.getThread({
          threadId: Number(threadIdParam),
          userId,
          workspaceId,
        });
        if (!thread) {
          return res.status(404).json({
            error: {
              message: "Thread not found",
              type: "invalid_request_error",
              code: "thread_not_found",
            },
          });
        }
        resolvedThreadId = thread.id;
      } else {
        resolvedThreadId = await ThreadEngine.createThread({
          userId,
          workspaceId,
          title: message.slice(0, 60),
        });
      }

      // --- 2. Save user message ---
      await MessageEngine.addMessage({
        threadId: resolvedThreadId,
        userId,
        role: "user",
        content: message,
        traceId,
      });

      // --- 3. Decision Orchestrator ---
      const persona: Persona = "unknown";
      const decisionCtx = await DecisionOrchestrator.run({
        message,
        persona,
        traceId,
        userId,
        threadId: resolvedThreadId,
        workspaceId,
        requestedThinkingProfile: "NORMAL",
        forceThinking: false,
      });

      if (decisionCtx.decision.verdict !== "APPROVE") {
        return res.status(200).json(buildNonStreamResponse(
          traceId,
          model,
          "[Request was blocked by safety filter]",
          "content_filter",
        ));
      }

      // --- 4. ChatEngine prompt build ---
      const engineResult = await ChatEngine.generateFromDecision(decisionCtx, {
        stream,
        workspaceId,
      });

      if (!engineResult.ok) {
        return res.status(200).json(buildNonStreamResponse(
          traceId,
          model,
          "[Unable to generate response]",
          "stop",
        ));
      }

      // Direct response shortcut
      if ((engineResult as any).directResponse === true) {
        const text = typeof (engineResult as any).text === "string"
          ? (engineResult as any).text
          : "";

        await MessageEngine.addMessage({
          threadId: resolvedThreadId,
          userId,
          role: "assistant",
          content: text,
          traceId,
        });

        if (stream) {
          return writeStreamResponse(res, traceId, model, text);
        }
        return res.json(buildNonStreamResponse(traceId, model, text, "stop"));
      }

      if (!("prompt" in engineResult)) {
        return res.status(500).json({
          error: {
            message: "Internal engine error",
            type: "server_error",
            code: "engine_error",
          },
        });
      }

      const { prompt, mode, meta } = engineResult;

      // --- 5. Stream mode ---
      if (stream) {
        StreamEngine.register(resolvedThreadId, traceId, {
          reasoning: decisionCtx.reasoning,
          conversationalOutcome: decisionCtx.conversationalOutcome,
          responseAffordance: decisionCtx.responseAffordance,
          turnIntent: decisionCtx.turnIntent,
          executionPlan: decisionCtx.executionPlan,
          allowContinuation: false,
        });

        // Start execution in background
        ExecutionEngine.execute({
          threadId: resolvedThreadId,
          traceId,
          workspaceId,
          userId,
          userName: req.user?.name ?? null,
          prompt,
          mode,
          thinkingProfile: decisionCtx.thinkingProfile,
          sessionId: null,
          outmode: meta?.outmode,
          stream: true,
          path: decisionCtx.path,
        }).catch((e) => {
          console.error("[V1][STREAM_EXEC_ERROR]", { traceId, error: String(e) });
        });

        // SSE response — subscribe to stream events and convert to OpenAI chunk format
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders();

        const completionId = `chatcmpl-${traceId.replace(/-/g, "").slice(0, 24)}`;
        const created = Math.floor(Date.now() / 1000);

        try {
          const streamIter = StreamEngine.subscribe(resolvedThreadId);

          for await (const rawEvent of streamIter as AsyncGenerator<YuaStreamEvent>) {
            if (rawEvent.event === "token" && typeof rawEvent.token === "string") {
              const chunk = {
                id: completionId,
                object: "chat.completion.chunk" as const,
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: { content: rawEvent.token },
                    finish_reason: null,
                  },
                ],
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }

            if (rawEvent.event === "done") {
              // Final chunk with finish_reason
              const finalChunk = {
                id: completionId,
                object: "chat.completion.chunk" as const,
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: "stop",
                  },
                ],
              };
              res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
              res.write("data: [DONE]\n\n");
              break;
            }
          }
        } catch (e) {
          console.error("[V1][STREAM_SSE_ERROR]", { traceId, error: String(e) });
        }

        res.end();
        return;
      }

      // --- 6. Non-stream mode ---
      const aiResult = await ExecutionEngine.execute({
        threadId: resolvedThreadId,
        traceId,
        workspaceId,
        userId,
        userName: req.user?.name ?? null,
        prompt,
        mode,
        thinkingProfile: decisionCtx.thinkingProfile,
        sessionId: null,
        outmode: meta?.outmode,
        stream: false,
        path: decisionCtx.path,
      });

      const text =
        typeof (aiResult as any).text === "string" ? (aiResult as any).text : "";

      // Save assistant message
      await MessageEngine.addMessage({
        threadId: resolvedThreadId,
        userId,
        role: "assistant",
        content: text,
        traceId,
      });

      return res.json(buildNonStreamResponse(traceId, model, text, "stop"));
    } catch (e: any) {
      console.error("[V1][FATAL]", {
        traceId,
        message: e?.message,
        stack: e?.stack,
      });

      return res.status(500).json({
        error: {
          message: "Internal server error",
          type: "server_error",
          code: "internal_error",
        },
      });
    }
  }
);

// --- Helpers ---

function buildNonStreamResponse(
  traceId: string,
  model: string,
  content: string,
  finishReason: "stop" | "length" | "content_filter"
) {
  return {
    id: `chatcmpl-${traceId.replace(/-/g, "").slice(0, 24)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

function writeStreamResponse(
  res: Response,
  traceId: string,
  model: string,
  content: string
): void {
  const completionId = `chatcmpl-${traceId.replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  // Send content as single token chunk
  const chunk = {
    id: completionId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);

  // Final chunk
  const finalChunk = {
    id: completionId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

// --- Tool Calls: Chat Completions → Responses API message converter ---
// Converts OpenAI Chat Completions message format to Responses API input items
// so that multi-turn tool conversations preserve full history.

function convertMessagesToResponsesInput(messages: V1Message[]): any[] {
  const items: any[] = [];
  // Map original call IDs (call_xxx) → Responses API IDs (fc_xxx)
  const idMap = new Map<string, string>();

  for (const msg of messages) {
    // System messages are handled by runOpenAIRuntime (SYSTEM_CORE_FINAL)
    if (msg.role === "system") continue;

    if (msg.role === "user") {
      items.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: msg.content ?? "" }],
      });
    } else if (msg.role === "assistant") {
      // Assistant with tool_calls → emit function_call items
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Emit text content if present alongside tool_calls
        if (msg.content) {
          items.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: msg.content }],
          });
        }
        for (const tc of msg.tool_calls) {
          // Responses API requires IDs starting with 'fc_'
          const fcId = tc.id.startsWith("fc_") ? tc.id : `fc_${tc.id.replace(/^call_/, "")}`;
          items.push({
            type: "function_call",
            id: fcId,
            call_id: fcId,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
          // Map original ID → fc_ ID for tool result matching
          idMap.set(tc.id, fcId);
        }
      } else if (msg.content) {
        // Plain assistant text
        items.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: msg.content }],
        });
      }
    } else if (msg.role === "tool") {
      // Tool result → function_call_output (use mapped fc_ ID)
      const originalId = msg.tool_call_id ?? "";
      const mappedId = idMap.get(originalId) ?? (originalId.startsWith("fc_") ? originalId : `fc_${originalId.replace(/^call_/, "")}`);
      items.push({
        type: "function_call_output",
        call_id: mappedId,
        output: msg.content ?? "",
      });
    }
  }

  return items;
}

// --- Tool Calls Mode Handler ---
// Bypasses ChatEngine/DecisionOrchestrator and calls runOpenAIRuntime directly
// with tools pass-through for YUAN Agent and external tool use scenarios.

async function handleToolCallsMode(
  _req: Request,
  res: Response,
  opts: {
    traceId: string;
    model: string;
    stream: boolean;
    message: string;
    messages: V1Message[];
    tools: V1Tool[];
    toolChoice?: V1RequestBody["tool_choice"];
    userId: number;
    workspaceId: string;
  },
): Promise<Response | void> {
  const { traceId, model, stream, message, messages, tools, toolChoice, workspaceId } = opts;
  const completionId = `chatcmpl-${traceId.replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  // Convert Chat Completions tool format → Responses API function tool format
  const responsesTools = tools.map((t) => ({
    type: "function" as const,
    name: t.function.name,
    description: t.function.description ?? "",
    parameters: t.function.parameters ?? { type: "object", properties: {} },
  }));

  // Build system prompt from messages
  const systemMsg = messages.find((m) => m.role === "system");
  const developerHint = systemMsg?.content ?? undefined;

  // Resolve mode from model (ChatMode SSOT)
  const modeMap: Record<string, string> = {
    "yua-basic": "FAST",
    "yua-normal": "NORMAL",
    "yua-pro": "DEEP",
    "yua-research": "RESEARCH",
  };
  const mode = (modeMap[model] ?? "NORMAL") as any;

  // Detect multi-turn tool conversation (has tool results or assistant tool_calls)
  const hasToolHistory = messages.some(
    (m) => m.role === "tool" || (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0),
  );

  // If multi-turn: convert full history to Responses API format via inputOverride
  // If first turn: use simple userMessage path (backward compatible)
  const inputOverride = hasToolHistory
    ? convertMessagesToResponsesInput(messages)
    : undefined;

  try {
    const result = await runOpenAIRuntime({
      traceId,
      workspaceId,
      userMessage: hasToolHistory ? undefined : message,
      developerHint,
      mode,
      stream,
      tools: responsesTools,
      toolChoice: toolChoice ?? "auto",
      inputOverride,
    });

    // --- Non-stream response ---
    if (result.type === "text") {
      return res.json({
        id: completionId,
        object: "chat.completion",
        created,
        model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: result.text },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }

    // --- Stream response ---
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    // Track tool calls being built
    const toolCallAccumulators = new Map<string, {
      index: number;
      id: string;
      name: string;
      arguments: string;
    }>();
    let toolCallIndex = 0;

    for await (const event of result.stream) {
      // Text delta → content chunk
      if (event.kind === "text_delta") {
        const chunk = {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      // tool_call_started → emit initial tool_calls delta
      if (event.kind === "tool_call_started" && event.name) {
        const callId = event.callId ?? `call_${crypto.randomUUID().slice(0, 8)}`;
        const idx = toolCallIndex++;
        toolCallAccumulators.set(callId, {
          index: idx,
          id: callId,
          name: event.name,
          arguments: "",
        });
        const chunk = {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: idx,
                id: callId,
                type: "function",
                function: { name: event.name, arguments: "" },
              }],
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      // tool_call_arguments_delta → append arguments
      if (event.kind === "tool_call_arguments_delta" && event.callId) {
        const acc = toolCallAccumulators.get(event.callId);
        if (acc) {
          acc.arguments += event.delta;
          const chunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: acc.index,
                  function: { arguments: event.delta },
                }],
              },
              finish_reason: null,
            }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
      }
    }

    // Final chunk
    const hasToolCalls = toolCallAccumulators.size > 0;
    const finalChunk = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: hasToolCalls ? "tool_calls" : "stop",
      }],
    };
    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  } catch (e: any) {
    console.error("[V1][TOOL_CALLS_ERROR]", { traceId, message: e?.message, stack: e?.stack });

    if (res.headersSent) {
      res.end();
      return;
    }
    return res.status(500).json({
      error: {
        message: "Tool calls execution failed",
        type: "server_error",
        code: "tool_calls_error",
      },
    });
  }
}

// --- API Key Stateless Handler ---
// API key 호출 시 DB 터치 없이 순수 LLM 호출 + 사용량 로그만 남김
async function handleApiKeyStateless(
  req: Request,
  res: Response,
  opts: {
    traceId: string;
    model: string;
    stream: boolean;
    message: string;
    messages: V1Message[];
    userId: number;
    workspaceId: string;
    startTime: number;
  },
): Promise<Response | void> {
  const { traceId, model, stream, message, messages, userId, workspaceId, startTime } = opts;
  const completionId = `chatcmpl-${traceId.replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  const systemMsg = messages.find((m) => m.role === "system");
  const modeMap: Record<string, string> = {
    "yua-basic": "FAST",
    "yua-normal": "NORMAL",
    "yua-pro": "DEEP",
    "yua-research": "RESEARCH",
  };
  const mode = (modeMap[model] ?? "FAST") as any;

  try {
    const result = await runOpenAIRuntime({
      traceId,
      workspaceId,
      userMessage: message,
      developerHint: systemMsg?.content ?? undefined,
      mode,
      stream,
    });

    // Non-stream
    if (result.type === "text") {
      const latency = Date.now() - startTime;

      // Fire-and-forget: 사용량 로그
      pgPool.query(
        `INSERT INTO api_usage_logs (user_id, scope, model, provider, latency_ms, status, request_summary, response_summary)
         VALUES ($1, 'yua', $2, 'yua', $3, 'success', $4, $5)`,
        [userId, model, latency, message.slice(0, 200), (result.text ?? "").slice(0, 200)]
      ).catch((e: any) => console.warn("[API_USAGE_LOG]", e?.message));

      return res.json({
        id: completionId,
        object: "chat.completion",
        created,
        model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: result.text },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }

    // Stream
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    let fullText = "";
    for await (const event of result.stream) {
      if (event.kind === "text_delta") {
        fullText += event.delta;
        const chunk = {
          id: completionId, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      // Stream ends when generator returns (no explicit "done" event)
    }

    const finalChunk = {
      id: completionId, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();

    // Fire-and-forget: 사용량 로그
    const latency = Date.now() - startTime;
    pgPool.query(
      `INSERT INTO api_usage_logs (user_id, scope, model, provider, latency_ms, status, request_summary, response_summary)
       VALUES ($1, 'yua', $2, 'yua', $3, 'success', $4, $5)`,
      [userId, model, latency, message.slice(0, 200), fullText.slice(0, 200)]
    ).catch((e: any) => console.warn("[API_USAGE_LOG]", e?.message));

    return;
  } catch (e: any) {
    console.error("[V1][API_STATELESS_ERROR]", { traceId, message: e?.message });

    // Fire-and-forget: 에러 로그
    pgPool.query(
      `INSERT INTO api_usage_logs (user_id, scope, model, provider, latency_ms, status, error_message, request_summary)
       VALUES ($1, 'yua', $2, 'yua', $3, 'error', $4, $5)`,
      [userId, model, Date.now() - startTime, (e?.message ?? "").slice(0, 200), message.slice(0, 200)]
    ).catch(() => {});

    if (res.headersSent) { res.end(); return; }
    return res.status(500).json({
      error: { message: "Internal server error", type: "server_error", code: "internal_error" },
    });
  }
}

export default router;
