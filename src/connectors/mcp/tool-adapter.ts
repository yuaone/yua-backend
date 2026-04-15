// src/connectors/mcp/tool-adapter.ts
// Convert MCP tool descriptors into the tool format expected by the
// OpenAI Responses API. This is a thin mapper — no logic beyond shape.

import type { LoadedMcpTool } from "./client-manager";

export interface OpenAiFunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: unknown;
  /** When true, the tool is not loaded into context initially.
   *  The model discovers it via tool_search and loads on demand. */
  defer_loading?: boolean;
}

/**
 * Sanitize MCP tool name for OpenAI API: replace "." with "__"
 * OpenAI pattern: ^[a-zA-Z0-9_-]+$
 * MCP format: "provider.toolName" → "provider__toolName"
 */
export function sanitizeMcpToolName(name: string): string {
  return name.replace(/\./g, "__");
}

/** Reverse: "provider__toolName" → "provider.toolName" */
export function unsanitizeMcpToolName(name: string): string {
  return name.replace(/__/, ".");
}

export function mcpToolsToOpenaiTools(
  mcpTools: LoadedMcpTool[],
  options?: { deferLoading?: boolean },
): OpenAiFunctionTool[] {
  return mcpTools.map((t) => ({
    type: "function" as const,
    name: sanitizeMcpToolName(t.name),
    description: t.description,
    parameters: t.inputSchema ?? { type: "object", properties: {} },
    ...(options?.deferLoading ? { defer_loading: true } : {}),
  }));
}
