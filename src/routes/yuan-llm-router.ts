/**
 * YUAN LLM Router — Stateless LLM endpoint for YUAN agent
 *
 * DB 터치 없음. 스레드/메시지 저장 없음.
 * YUAN 에이전트가 LLM 두뇌로 사용하는 순수 호출 엔드포인트.
 *
 * 마운트: /api/yuan-agent/llm
 * 인증: requireAuthOrApiKey("yuan") (라우트 index.ts에서 처리)
 *
 * Providers:
 *   "yua"    → runOpenAIRuntime (YUA 내부 두뇌)
 *   "openai" → OpenAI API 직접 호출 (BYOK)
 *   "claude" → Anthropic API 직접 호출 (BYOK)
 */

import { Router, Request, Response } from "express";
import crypto from "crypto";
import { runOpenAIRuntime } from "../ai/chat/runtime/openai-runtime";
import type { OpenAIRuntimeEvent } from "../ai/chat/runtime/openai-runtime";

const router = Router();

/* ──────────────────────────────────────────
   Types
────────────────────────────────────────── */

interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface LLMTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface LLMRequestBody {
  provider?: "yua" | "openai" | "claude";
  model?: string;
  messages: LLMMessage[];
  tools?: LLMTool[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
  stream?: boolean;
  // BYOK: 유저가 직접 제공하는 API key (openai/claude provider 전용)
  api_key?: string;
}

/* ──────────────────────────────────────────
   Helpers
────────────────────────────────────────── */

function convertMessagesToResponsesInput(messages: LLMMessage[]): any[] {
  const items: any[] = [];
  const idMap = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role === "system") continue;

    if (msg.role === "user") {
      items.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: msg.content ?? "" }],
      });
    } else if (msg.role === "assistant") {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        if (msg.content) {
          items.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: msg.content }],
          });
        }
        for (const tc of msg.tool_calls) {
          const fcId = tc.id.startsWith("fc_") ? tc.id : `fc_${tc.id.replace(/^call_/, "")}`;
          items.push({
            type: "function_call",
            id: fcId,
            call_id: fcId,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
          idMap.set(tc.id, fcId);
        }
      } else if (msg.content) {
        items.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: msg.content }],
        });
      }
    } else if (msg.role === "tool") {
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

/* ──────────────────────────────────────────
   POST /chat — Stateless LLM call
   OpenAI-compatible request/response format
────────────────────────────────────────── */
router.post("/chat", async (req: Request, res: Response) => {
  const traceId = crypto.randomUUID();
  const startTime = Date.now();

  try {
    const body = req.body as LLMRequestBody;
    const provider = body.provider ?? "yua";
    const model = body.model ?? "yua-normal";
    const stream = body.stream === true;

    // Validate messages
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "messages is required and must be a non-empty array",
      });
    }

    const lastUserMsg = [...body.messages].reverse().find((m) => m.role === "user");
    if (!lastUserMsg?.content?.trim() && !body.messages.some(m => m.role === "tool")) {
      return res.status(400).json({
        ok: false,
        error: "messages must contain at least one user message or tool result",
      });
    }

    const workspaceId = req.workspace?.id ?? "internal";
    const completionId = `chatcmpl-${traceId.replace(/-/g, "").slice(0, 24)}`;
    const created = Math.floor(Date.now() / 1000);

    /* ──── Provider: YUA (internal) ──── */
    if (provider === "yua") {
      const systemMsg = body.messages.find((m) => m.role === "system");
      // ChatMode SSOT: FAST | NORMAL | SEARCH | DEEP | BENCH | RESEARCH
      const modeMap: Record<string, string> = {
        "yua-basic": "FAST",       // gpt-5-mini (저비용, 빠른 응답)
        "yua-normal": "NORMAL",    // gpt-5.2-chat-latest (기본)
        "yua-pro": "DEEP",         // gpt-5.2 (고품질, reasoning)
        "yua-research": "RESEARCH", // gpt-5.2-chat-latest (심층 리서치)
      };
      const mode = (modeMap[model] ?? "NORMAL") as any;

      // Convert tools to Responses API format
      const responsesTools = body.tools?.map((t) => ({
        type: "function" as const,
        name: t.function.name,
        description: t.function.description ?? "",
        parameters: t.function.parameters ?? { type: "object", properties: {} },
      }));

      // Detect multi-turn
      const hasToolHistory = body.messages.some(
        (m) => m.role === "tool" || (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0),
      );

      const inputOverride = hasToolHistory
        ? convertMessagesToResponsesInput(body.messages)
        : undefined;

      const result = await runOpenAIRuntime({
        traceId,
        workspaceId,
        userMessage: hasToolHistory ? undefined : (lastUserMsg?.content ?? ""),
        developerHint: systemMsg?.content ?? undefined,
        mode,
        stream,
        tools: responsesTools,
        toolChoice: body.tool_choice ?? "auto",
        inputOverride,
      });

      // Non-stream
      if (result.type === "text") {
        return res.json({
          id: completionId,
          object: "chat.completion",
          created,
          model,
          provider: "yua",
          choices: [{
            index: 0,
            message: { role: "assistant", content: result.text },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          latency_ms: Date.now() - startTime,
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

      const toolCallAccumulators = new Map<string, {
        index: number;
        id: string;
        name: string;
        arguments: string;
      }>();
      let toolCallIndex = 0;

      for await (const event of result.stream) {
        if (event.kind === "text_delta") {
          const chunk = {
            id: completionId, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }

        if (event.kind === "tool_call_started" && event.name) {
          const callId = event.callId ?? `call_${crypto.randomUUID().slice(0, 8)}`;
          const idx = toolCallIndex++;
          toolCallAccumulators.set(callId, { index: idx, id: callId, name: event.name, arguments: "" });
          const chunk = {
            id: completionId, object: "chat.completion.chunk", created, model,
            choices: [{
              index: 0,
              delta: { tool_calls: [{ index: idx, id: callId, type: "function", function: { name: event.name, arguments: "" } }] },
              finish_reason: null,
            }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }

        if (event.kind === "tool_call_arguments_delta" && event.callId) {
          const acc = toolCallAccumulators.get(event.callId);
          if (acc) {
            acc.arguments += event.delta;
            const chunk = {
              id: completionId, object: "chat.completion.chunk", created, model,
              choices: [{
                index: 0,
                delta: { tool_calls: [{ index: acc.index, function: { arguments: event.delta } }] },
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
        id: completionId, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: {}, finish_reason: hasToolCalls ? "tool_calls" : "stop" }],
      };
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    /* ──── Provider: OpenAI (BYOK) ──── */
    if (provider === "openai") {
      const apiKey = body.api_key;
      if (!apiKey) {
        return res.status(400).json({ ok: false, error: "api_key is required for openai provider" });
      }

      const openaiBody: any = {
        model: model || "gpt-4.1-mini",
        messages: body.messages,
        stream,
      };
      if (body.tools?.length) {
        openaiBody.tools = body.tools;
        openaiBody.tool_choice = body.tool_choice ?? "auto";
      }

      const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(openaiBody),
      });

      if (stream) {
        res.writeHead(openaiRes.status, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders();

        const reader = openaiRes.body?.getReader();
        if (reader) {
          const decoder = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(decoder.decode(value, { stream: true }));
          }
        }
        res.end();
        return;
      }

      const data = await openaiRes.json();
      return res.status(openaiRes.status).json(data);
    }

    /* ──── Provider: Claude (BYOK) ──── */
    if (provider === "claude") {
      const apiKey = body.api_key;
      if (!apiKey) {
        return res.status(400).json({ ok: false, error: "api_key is required for claude provider" });
      }

      // Convert OpenAI format → Anthropic format
      const systemMsg = body.messages.find(m => m.role === "system");
      const nonSystemMsgs = body.messages.filter(m => m.role !== "system");

      const anthropicBody: any = {
        model: model || "claude-sonnet-4-20250514",
        max_tokens: 8192,
        messages: nonSystemMsgs.map(m => ({
          role: m.role === "tool" ? "user" : m.role,
          content: m.role === "tool"
            ? [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content ?? "" }]
            : m.content ?? "",
        })),
        stream,
      };
      if (systemMsg?.content) {
        anthropicBody.system = systemMsg.content;
      }
      if (body.tools?.length) {
        anthropicBody.tools = body.tools.map(t => ({
          name: t.function.name,
          description: t.function.description ?? "",
          input_schema: t.function.parameters ?? { type: "object", properties: {} },
        }));
      }

      const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(anthropicBody),
      });

      if (!stream) {
        const data: any = await claudeRes.json();
        // Convert Anthropic response → OpenAI format
        const textBlock = data.content?.find((b: any) => b.type === "text");
        const toolBlocks = data.content?.filter((b: any) => b.type === "tool_use") ?? [];

        const message: any = { role: "assistant", content: textBlock?.text ?? null };
        if (toolBlocks.length > 0) {
          message.tool_calls = toolBlocks.map((tb: any, i: number) => ({
            id: tb.id ?? `call_${i}`,
            type: "function",
            function: { name: tb.name, arguments: JSON.stringify(tb.input ?? {}) },
          }));
        }

        return res.json({
          id: completionId,
          object: "chat.completion",
          created,
          model,
          provider: "claude",
          choices: [{
            index: 0,
            message,
            finish_reason: data.stop_reason === "tool_use" ? "tool_calls" : "stop",
          }],
          usage: {
            prompt_tokens: data.usage?.input_tokens ?? 0,
            completion_tokens: data.usage?.output_tokens ?? 0,
            total_tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
          },
          latency_ms: Date.now() - startTime,
        });
      }

      // Claude stream → passthrough (TODO: convert SSE format)
      res.writeHead(claudeRes.status, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      const reader = claudeRes.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
        }
      }
      res.end();
      return;
    }

    return res.status(400).json({ ok: false, error: `Unknown provider: ${provider}` });

  } catch (e: any) {
    console.error("[YUAN_LLM] /chat error:", { traceId, message: e?.message, stack: e?.stack });
    return res.status(500).json({
      ok: false,
      error: "llm_call_failed",
      message: e?.message ?? "Internal error",
    });
  }
});

export default router;
