// src/connectors/mcp/mcp-prompt-builder.ts
// Builds the MCP tool guidance block for the system prompt.

import type { ConnectorTool } from "yua-shared";

/**
 * Build a prompt block describing available MCP tools.
 * Empty string if no tools → PromptBuilder skips it.
 */
export function buildMcpPromptBlock(tools: ConnectorTool[]): string {
  if (!tools || tools.length === 0) return "";

  const toolLines = tools
    .map((t) => `- ${t.qualifiedName}: ${t.description || "(설명 없음)"}`)
    .join("\n");

  // Group tools by provider for clarity
  const byProvider = new Map<string, typeof tools>();
  for (const t of tools) {
    const p = t.provider ?? t.qualifiedName.split(".")[0] ?? "unknown";
    if (!byProvider.has(p)) byProvider.set(p, []);
    byProvider.get(p)!.push(t);
  }

  const providerBlocks = Array.from(byProvider.entries())
    .map(([provider, pts]) => {
      const toolDescs = pts
        .map((t) => {
          const params = t.inputSchema && typeof t.inputSchema === "object"
            ? Object.keys((t.inputSchema as any).properties ?? {}).join(", ")
            : "";
          return `  - ${t.qualifiedName}${params ? ` (params: ${params})` : ""}\n    ${t.description || "(no description)"}`;
        })
        .join("\n");
      return `[${provider}] ${pts.length} tool(s):\n${toolDescs}`;
    })
    .join("\n\n");

  return `[CONNECTED EXTERNAL TOOLS — MCP]

You have ${tools.length} external MCP tool(s) connected to this session by the user.
These tools call real external APIs — they are NOT stubs. The user has already authorized them.

## How to use MCP tools

1. **Match user intent to tool capability.** When the user asks something an MCP tool can answer, call that tool via function call. Prefer MCP tools over generating answers from memory when the tool provides live/authoritative data.

2. **Tool names are prefixed by provider.** Format: \`<provider>.<tool_name>\`. Call with the full qualified name.
   Example: \`context7.get-library-docs\`, \`huggingface.hub_repo_search\`

3. **Check parameter schema.** Each tool has an input_schema. Only pass parameters defined in the schema. Required parameters must always be provided.

4. **No confirmation needed.** The user pre-authorized these tools by connecting them. Call them directly when relevant — do not ask "should I use this tool?"

5. **Handle errors gracefully.** If a tool call fails, explain the error and suggest alternatives or a retry.

6. **New tools may appear dynamically.** When new MCP providers are connected mid-conversation, their tools become available immediately. Treat any new tool the same way: read its name + description + parameters, match to user intent, and call when appropriate.

7. **Never fabricate tool results.** If you cannot call the tool or it returns an error, say so. Do not pretend the tool returned data it didn't.

## Connected tools

${providerBlocks}`;
}
