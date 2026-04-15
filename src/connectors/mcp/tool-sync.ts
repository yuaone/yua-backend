// src/connectors/mcp/tool-sync.ts
// Persist MCP listTools() results to user_connector_tools table.
// Called on connector add + manual re-sync.

import { pgPool } from "../../db/postgres";
import type { LoadedMcpTool } from "./client-manager";
import type { ConnectorTool, SyncToolsResponse } from "yua-shared";

export const MAX_SCHEMA_BYTES = 50_000;
export const MAX_DESC_LENGTH = 500;

function sanitizeTool(t: LoadedMcpTool): {
  toolName: string;
  qualifiedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
} {
  const schemaStr = JSON.stringify(t.inputSchema ?? {});
  const schema =
    schemaStr.length > MAX_SCHEMA_BYTES
      ? { type: "object", properties: {} }
      : (t.inputSchema as Record<string, unknown>) ?? {};
  return {
    toolName: t._toolName,
    qualifiedName: t.name,
    description: (t.description || "").slice(0, MAX_DESC_LENGTH),
    inputSchema: schema,
  };
}

/**
 * Sync MCP tools from a live session to DB. Performs diff:
 * - New tools → INSERT
 * - Removed tools → DELETE
 * - Existing tools → UPDATE description/schema if changed
 * Returns sync stats.
 */
export async function syncConnectorTools(
  userId: number,
  connectorId: number,
  provider: string,
  mcpTools: LoadedMcpTool[],
): Promise<SyncToolsResponse> {
  const client = await pgPool.connect();
  try {
    await client.query("BEGIN");

    // 1. Get existing tools
    const { rows: existing } = await client.query<{
      id: string;
      tool_name: string;
      description: string;
      input_schema: unknown;
    }>(
      `SELECT id, tool_name, description, input_schema
       FROM user_connector_tools
       WHERE user_id = $1 AND connector_id = $2`,
      [userId, connectorId],
    );
    const existingMap = new Map(existing.map((r) => [r.tool_name, r]));

    const incoming = mcpTools.map(sanitizeTool);
    const incomingNames = new Set(incoming.map((t) => t.toolName));

    let added = 0;
    let removed = 0;
    let unchanged = 0;

    // 2. Insert new / update existing
    for (const t of incoming) {
      const ex = existingMap.get(t.toolName);
      if (!ex) {
        await client.query(
          `INSERT INTO user_connector_tools
             (user_id, connector_id, provider, tool_name, qualified_name, description, input_schema)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [userId, connectorId, provider, t.toolName, t.qualifiedName, t.description, JSON.stringify(t.inputSchema)],
        );
        added++;
      } else {
        // Update description/schema if changed
        const schemaChanged =
          JSON.stringify(ex.input_schema) !== JSON.stringify(t.inputSchema);
        if (ex.description !== t.description || schemaChanged) {
          await client.query(
            `UPDATE user_connector_tools
             SET description = $1, input_schema = $2, qualified_name = $3, updated_at = NOW()
             WHERE id = $4`,
            [t.description, JSON.stringify(t.inputSchema), t.qualifiedName, ex.id],
          );
          // updated — don't count as unchanged
        } else {
          unchanged++;
        }
      }
    }

    // 3. Delete removed tools
    for (const [name, row] of existingMap) {
      if (!incomingNames.has(name)) {
        await client.query(
          `DELETE FROM user_connector_tools WHERE id = $1`,
          [row.id],
        );
        removed++;
      }
    }

    // 4. Update connector metadata
    await client.query(
      `UPDATE user_connectors
       SET tool_count = $1, last_synced = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [incoming.length, connectorId],
    );

    await client.query("COMMIT");

    // 5. Fetch final state
    const { rows: finalTools } = await client.query(
      `SELECT * FROM user_connector_tools
       WHERE user_id = $1 AND connector_id = $2
       ORDER BY tool_name ASC`,
      [userId, connectorId],
    );

    const { rows: connRows } = await client.query(
      `SELECT * FROM user_connectors WHERE id = $1`,
      [connectorId],
    );

    return {
      connector: mapConnectorRow(connRows[0]),
      tools: finalTools.map(mapToolRow),
      added,
      removed,
      unchanged,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get enabled tools for a user — only from chat-enabled connectors.
 * Used by execution-engine to know which MCP tools to inject.
 */
export async function getEnabledToolsForChat(
  userId: number,
): Promise<ConnectorTool[]> {
  const { rows } = await pgPool.query(
    `SELECT t.*
     FROM user_connector_tools t
     JOIN user_connectors c ON c.id = t.connector_id
     LEFT JOIN user_connector_toggles tog
       ON tog.user_id = t.user_id AND tog.connector_id = t.connector_id
     WHERE t.user_id = $1
       AND t.enabled = TRUE
       AND c.status = 'connected'
       AND COALESCE(tog.chat_enabled, TRUE) = TRUE
     ORDER BY t.provider, t.tool_name`,
    [userId],
  );
  return rows.map(mapToolRow);
}

export function mapToolRow(row: any): ConnectorTool {
  return {
    id: Number(row.id),
    connectorId: Number(row.connector_id),
    provider: String(row.provider),
    toolName: String(row.tool_name),
    qualifiedName: String(row.qualified_name),
    description: String(row.description || ""),
    inputSchema:
      typeof row.input_schema === "string"
        ? JSON.parse(row.input_schema)
        : row.input_schema ?? {},
    enabled: Boolean(row.enabled),
  };
}

export function mapConnectorRow(row: any): import("yua-shared").ConnectorInstance {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    provider: String(row.provider) as any,
    displayName: String(row.display_name || row.provider),
    status: String(row.status) as any,
    authType: (row.auth_type || "oauth") as any,
    isCustom: Boolean(row.is_custom),
    serverUrl: row.server_url || null,
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    externalId: row.external_id ?? undefined,
    toolCount: Number(row.tool_count || 0),
    lastSynced: row.last_synced ? new Date(row.last_synced).toISOString() : null,
    connectedAt: new Date(row.connected_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
