// src/connectors/mcp/client-manager.ts
// Per-request MCP client session manager.
//
// On each chat request:
//   1. openUserMcpSession(userId) loads all active connectors
//   2. For each connector, connects to its MCP server via Streamable HTTP
//      with the user's decrypted bearer token in Authorization header
//   3. Aggregates all tools across providers (prefixed with provider id
//      to avoid name collisions)
//   4. Caller runs the LLM; any tool call whose name starts with
//      "<provider>." routes through callMcpTool
//   5. Caller MUST await session.close() in a finally — we don't cache
//      sessions to avoid stale tokens and to keep memory bounded
//
// If the SDK cannot be imported (e.g. Node16 resolution + missing dist), the
// whole module gracefully no-ops — settings UI still works, just no tools.

import { listActiveConnectors, loadConnectorWithSecrets, isGoogleProvider, isTokenLikelyExpired, refreshGoogleToken } from "../oauth/token-store";
import { resolveServerUrlFromRow } from "./servers";

export interface LoadedMcpTool {
  name: string;            // "github.create_issue"
  description: string;
  inputSchema: unknown;
  _provider: string;
  _toolName: string;       // "create_issue"
}

interface ClientSession {
  provider: string;
  client: any;             // Client from @modelcontextprotocol/sdk
  tools: LoadedMcpTool[];
}

export interface UserMcpSession {
  sessions: ClientSession[];
  close: () => Promise<void>;
}

import { syncConnectorTools } from "./tool-sync";

let sdkCache: {
  Client: any;
  StreamableHTTPClientTransport: any;
} | null = null;
let sdkUnavailable = false;

async function loadSdk(): Promise<typeof sdkCache> {
  if (sdkCache) return sdkCache;
  if (sdkUnavailable) return null;
  try {
    const clientMod: any = await import("@modelcontextprotocol/sdk/client/index.js");
    const transportMod: any = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    sdkCache = {
      Client: clientMod.Client,
      StreamableHTTPClientTransport: transportMod.StreamableHTTPClientTransport,
    };
    return sdkCache;
  } catch (err) {
    console.warn("[mcp] SDK unavailable — MCP tools disabled", err);
    sdkUnavailable = true;
    return null;
  }
}

const EMPTY_SESSION: UserMcpSession = {
  sessions: [],
  close: async () => {},
};

/**
 * Open MCP clients for all active connectors of this user. Never throws:
 * failure to load SDK or connect to any single provider is logged + skipped.
 */
export async function openUserMcpSession(
  userId: number,
  providerFilter?: string[],
): Promise<UserMcpSession> {
  const sdk = await loadSdk();
  if (!sdk) return EMPTY_SESSION;

  let rows: any[] = [];
  try {
    rows = await listActiveConnectors(userId);
  } catch (err) {
    console.warn("[mcp] listActiveConnectors failed", err);
    return EMPTY_SESSION;
  }

  // Filter to only needed providers (MoP gate optimization)
  if (providerFilter && providerFilter.length > 0) {
    const allowed = new Set(providerFilter);
    rows = rows.filter((r) => allowed.has(r.provider));
    console.log("[MCP][PROVIDER_FILTER]", { before: rows.length + providerFilter.length, after: rows.length, allowed: providerFilter });
  }

  // 🔥 PERF: Connect to all MCP providers in PARALLEL (was sequential → 3-5s delay)
  const sessions: ClientSession[] = [];

  const connectResults = await Promise.allSettled(
    rows.map(async (row) => {
      const serverUrl = resolveServerUrlFromRow(row);
      if (!serverUrl) return null;

      const authType = (row as any).authType ?? (row as any).auth_type ?? "oauth";
      let bearerToken = "";
      if (authType !== "none") {
        const withSecrets = await loadConnectorWithSecrets(userId, row.provider);
        if (!withSecrets?.accessToken) return null;

        // 🔥 Google token auto-refresh: access_token expires in 1hr
        if (isGoogleProvider(row.provider) && isTokenLikelyExpired(withSecrets.updatedAt)) {
          console.log("[MCP][TOKEN_REFRESH] attempting", { provider: row.provider, age: Date.now() - new Date(withSecrets.updatedAt).getTime() });
          const refreshed = await refreshGoogleToken(userId, row.provider);
          if (refreshed) {
            bearerToken = refreshed;
          } else {
            console.warn("[MCP][TOKEN_REFRESH] failed, using old token", { provider: row.provider });
            bearerToken = withSecrets.accessToken;
          }
        } else {
          bearerToken = withSecrets.accessToken;
        }
      }

      const transportOpts: any = {};
      if (bearerToken) {
        transportOpts.requestInit = {
          headers: { Authorization: `Bearer ${bearerToken}` },
        };
      }

      const transport = new sdk.StreamableHTTPClientTransport(
        new URL(serverUrl),
        transportOpts,
      );

      const client = new sdk.Client(
        { name: "yua-backend", version: "1.0.0" },
        { capabilities: {} },
      );

      await client.connect(transport);
      const listResp: any = await client.listTools();
      const rawTools: any[] = Array.isArray(listResp?.tools) ? listResp.tools : [];

      const tools: LoadedMcpTool[] = rawTools.map((t: any) => ({
        name: `${row.provider}.${t.name}`,
        description: typeof t.description === "string" ? t.description : "",
        inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        _provider: row.provider,
        _toolName: String(t.name),
      }));

      // Auto-sync (non-blocking)
      syncConnectorTools(userId, Number(row.id), row.provider, tools).catch((e) =>
        console.warn(`[mcp] auto-sync failed for ${row.provider}`, e)
      );

      return { provider: row.provider, client, tools } as ClientSession;
    })
  );

  for (const result of connectResults) {
    if (result.status === "fulfilled" && result.value) {
      sessions.push(result.value);
    } else if (result.status === "rejected") {
      console.warn(`[mcp] connect failed`, result.reason?.message ?? result.reason);
    }
  }

  return {
    sessions,
    close: async () => {
      for (const s of sessions) {
        try {
          await s.client.close();
        } catch (err) {
          console.warn(`[mcp] close error ${s.provider}`, err);
        }
      }
    },
  };
}

// ── Lazy MCP: single-provider session for on-demand tool calls ──

export interface LazyMcpSession {
  client: any;
  provider: string;
  close: () => Promise<void>;
}

/**
 * Open a single MCP provider session lazily (on first tool call).
 * Skips listTools — schema comes from DB cache.
 * Includes token refresh, 8s timeout, AbortSignal propagation.
 */
export async function openSingleProviderSession(
  userId: number,
  provider: string,
  signal?: AbortSignal,
): Promise<LazyMcpSession | null> {
  const sdk = await loadSdk();
  if (!sdk) return null;

  const start = Date.now();
  const CONNECT_TIMEOUT = 8_000;

  // Abort controller: combines caller's signal + timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONNECT_TIMEOUT);
  if (signal?.aborted) { clearTimeout(timeout); return null; }
  signal?.addEventListener("abort", () => controller.abort(), { once: true });

  try {
    const rows = await listActiveConnectors(userId);
    const row = rows.find((r) => r.provider === provider);
    if (!row) {
      console.warn("[MCP_LAZY][NO_ROW]", { userId, provider });
      return null;
    }

    const serverUrl = resolveServerUrlFromRow(row);
    if (!serverUrl) {
      console.warn("[MCP_LAZY][NO_URL]", { provider });
      return null;
    }

    const authType = (row as any).authType ?? (row as any).auth_type ?? "oauth";
    let bearerToken = "";
    if (authType !== "none") {
      const withSecrets = await loadConnectorWithSecrets(userId, provider);
      if (!withSecrets?.accessToken) return null;

      if (isGoogleProvider(provider) && isTokenLikelyExpired(withSecrets.updatedAt)) {
        const refreshed = await refreshGoogleToken(userId, provider);
        bearerToken = refreshed || withSecrets.accessToken;
      } else {
        bearerToken = withSecrets.accessToken;
      }
    }

    if (controller.signal.aborted) return null;

    const transportOpts: any = {};
    if (bearerToken) {
      transportOpts.requestInit = {
        headers: { Authorization: `Bearer ${bearerToken}` },
      };
    }

    const transport = new sdk.StreamableHTTPClientTransport(
      new URL(serverUrl),
      transportOpts,
    );
    const client = new sdk.Client(
      { name: "yua-backend", version: "1.0.0" },
      { capabilities: {} },
    );

    await client.connect(transport);

    console.log("[MCP_LAZY][CONNECT]", { provider, ms: Date.now() - start, cached: false });

    return {
      client,
      provider,
      close: async () => {
        try { await client.close(); } catch {}
      },
    };
  } catch (err: any) {
    console.error("[MCP_LAZY][CONNECT_FAIL]", { provider, error: err?.message, ms: Date.now() - start });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Call a tool on a lazy session. Extracts text from MCP CallToolResult.
 */
export async function callLazyMcpTool(
  session: LazyMcpSession,
  toolName: string,
  args: unknown,
): Promise<string> {
  const raw: any = await session.client.callTool({
    name: toolName,
    arguments: args ?? {},
  });

  if (raw && typeof raw === "object" && Array.isArray(raw.content)) {
    const parts = raw.content
      .filter((c: any) => c.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text as string);
    if (parts.length > 0) return parts.join("\n\n");
  }
  return typeof raw === "string" ? raw : JSON.stringify(raw);
}

/**
 * Dispatch a single MCP tool call. Tool name is "<provider>.<toolName>".
 * Returns whatever the MCP server sent back (shape depends on the server).
 */
export async function callMcpTool(
  session: UserMcpSession,
  fullName: string,
  args: unknown,
): Promise<unknown> {
  const idx = fullName.indexOf(".");
  if (idx <= 0) throw new Error(`invalid MCP tool name: ${fullName}`);
  const provider = fullName.slice(0, idx);
  const toolName = fullName.slice(idx + 1);
  const s = session.sessions.find((x) => x.provider === provider);
  if (!s) throw new Error(`MCP provider not connected: ${provider}`);
  const raw: any = await s.client.callTool({
    name: toolName,
    arguments: args ?? {},
  });

  // Extract text from MCP CallToolResult envelope:
  // { content: [{type:"text", text:"..."}, ...], isError: bool }
  // Returns plain text so the model (and activity panel) see readable content, not JSON wrapper.
  if (raw && typeof raw === "object" && Array.isArray(raw.content)) {
    const parts = raw.content
      .filter((c: any) => c.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text as string);
    if (parts.length > 0) return parts.join("\n\n");
  }
  return typeof raw === "string" ? raw : JSON.stringify(raw);
}

/**
 * Collect all loaded tools across every provider in a session. Used by
 * the execution engine to inject into the LLM's tools[] parameter.
 */
export function collectAllTools(session: UserMcpSession): LoadedMcpTool[] {
  return session.sessions.flatMap((s) => s.tools);
}
