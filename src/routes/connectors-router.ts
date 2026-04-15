// 📂 src/routes/connectors-router.ts
// Phase 1 — Interest capture endpoints for the settings "연결된 앱" shell.
// Mount point in routes/index.ts should apply requireFirebaseAuth (+ rateLimit).
// Phase 2 will replace the hardcoded "waitlist" status with real user_connectors lookups.

import { Router, Request, Response } from "express";
import {
  CONNECTOR_CATALOG,
  type ConnectorProvider,
} from "yua-shared";
import {
  registerInterest,
  unregisterInterest,
  listInterestsForUser,
  countInterestsByProvider,
} from "../connectors/interest-repo";
import {
  upsertConnector,
  findConnector,
  deleteConnector,
  listAllConnectors,
} from "../connectors/oauth/token-store";
import {
  openUserMcpSession,
  collectAllTools,
} from "../connectors/mcp/client-manager";
import {
  syncConnectorTools,
  mapConnectorRow,
  mapToolRow,
} from "../connectors/mcp/tool-sync";
import { pgPool } from "../db/postgres";

const router = Router();

function getUserId(req: Request): number | null {
  const raw = (req as any).user?.userId ?? (req as any).user?.id;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isKnownProvider(id: string): id is ConnectorProvider {
  return Object.prototype.hasOwnProperty.call(CONNECTOR_CATALOG, id);
}

/* -------------------------------------------------------
 * GET /api/connectors
 * Returns the full catalog with per-user interest state + aggregate counts.
 * ----------------------------------------------------- */
router.get("/", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });

    // Phase 2: live connection state from user_connectors overlays the static
    // catalog. If provider has no row → "not_connected" → UI shows [연결].
    // Phase 1 interest data is still returned so the waitlist UI can render
    // for providers that don't yet have a real OAuth implementation.
    const providerIds = Object.keys(CONNECTOR_CATALOG) as ConnectorProvider[];

    const [myInterests, counts, ...connectorRows] = await Promise.all([
      listInterestsForUser(userId),
      countInterestsByProvider(),
      ...providerIds.map((id) => findConnector(userId, id)),
    ]);
    const mySet = new Set<ConnectorProvider>(myInterests);
    const rowByProvider = new Map<string, any>();
    providerIds.forEach((id, i) => {
      if (connectorRows[i]) rowByProvider.set(id, connectorRows[i]);
    });

    // Only GitHub has a real OAuth flow today. Anything else falls back to
    // the waitlist card so the UX stays honest.
    const PHASE2_PROVIDERS = new Set<string>(["github", "gdrive", "gmail", "google_calendar", "context7", "huggingface"]);

    const catalog = providerIds.map((id) => {
      const meta = CONNECTOR_CATALOG[id];
      const row = rowByProvider.get(id);
      const hasRealOAuth = PHASE2_PROVIDERS.has(id);
      const status = row
        ? (row.status as string)
        : hasRealOAuth
          ? "not_connected"
          : "waitlist";

      return {
        id: meta.id,
        numericId: row?.id ?? null, // 🔥 DB numeric ID for tool management UI
        name: meta.name,
        description: meta.description,
        icon: meta.icon,
        authType: meta.authType,
        scopes: meta.scopes,
        docsUrl: meta.docsUrl,
        status,
        connectedAt: row?.connectedAt ?? null,
        externalId: row?.externalId ?? null,
        toolCount: row?.toolCount ?? 0,
        lastSynced: row?.lastSynced ?? null,
        interestedByMe: mySet.has(id),
        interestedCount: counts[id] ?? 0,
      };
    });

    return res.json({
      catalog,
      phase: "hybrid",
      message:
        "연결 지원이 시작된 서비스는 [연결] 로, 준비 중인 서비스는 [알림 받기] 로 표시됩니다.",
    });
  } catch (err: any) {
    return res
      .status(500)
      .json({ ok: false, error: "internal_error", detail: err?.message });
  }
});

/* -------------------------------------------------------
 * DELETE /api/connectors/:id
 * Disconnect (revoke) a live OAuth connector.
 * ----------------------------------------------------- */
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });
    const id = String(req.params.id ?? "");
    // 🔥 Support both known providers (by slug) and custom connectors (by numeric DB id or custom slug)
    if (!isKnownProvider(id)) {
      // Try as numeric DB id or custom provider slug
      const existing = await findConnector(userId, id);
      if (!existing) {
        // Try by numeric id
        const { rows } = await pgPool.query(
          `SELECT provider FROM user_connectors WHERE id = $1 AND user_id = $2`,
          [id, userId],
        );
        if (rows.length === 0) {
          return res.status(404).json({ ok: false, error: "CONNECTOR_NOT_FOUND" });
        }
        await deleteConnector(userId, rows[0].provider);
        return res.json({ ok: true, status: "not_connected" });
      }
    }
    await deleteConnector(userId, id);
    return res.json({ ok: true, status: "not_connected" });
  } catch (err: any) {
    return res
      .status(500)
      .json({ ok: false, error: "internal_error", detail: err?.message });
  }
});

/* -------------------------------------------------------
 * POST /api/connectors/:id/interest
 * Register interest for the authenticated user.
 * ----------------------------------------------------- */
router.post("/:id/interest", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });

    const id = String(req.params.id ?? "");
    if (!isKnownProvider(id)) {
      return res.status(400).json({ ok: false, error: "UNKNOWN_PROVIDER" });
    }

    await registerInterest(userId, id);
    return res.json({ ok: true, interested: true });
  } catch (err: any) {
    if (err?.message === "UNKNOWN_PROVIDER") {
      return res.status(400).json({ ok: false, error: "UNKNOWN_PROVIDER" });
    }
    return res
      .status(500)
      .json({ ok: false, error: "internal_error", detail: err?.message });
  }
});

/* -------------------------------------------------------
 * DELETE /api/connectors/:id/interest
 * Unregister interest for the authenticated user.
 * ----------------------------------------------------- */
router.delete("/:id/interest", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });

    const id = String(req.params.id ?? "");
    if (!isKnownProvider(id)) {
      return res.status(400).json({ ok: false, error: "UNKNOWN_PROVIDER" });
    }

    await unregisterInterest(userId, id);
    return res.json({ ok: true, interested: false });
  } catch (err: any) {
    if (err?.message === "UNKNOWN_PROVIDER") {
      return res.status(400).json({ ok: false, error: "UNKNOWN_PROVIDER" });
    }
    return res
      .status(500)
      .json({ ok: false, error: "internal_error", detail: err?.message });
  }
});

/* -------------------------------------------------------
 * GET /api/connectors/custom — List all custom connectors for the user
 * ----------------------------------------------------- */
router.get("/custom", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "unauthorized" });

    const all = await listAllConnectors(userId);
    const custom = all.filter((c) => c.isCustom);
    return res.json({ connectors: custom });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/* -------------------------------------------------------
 * POST /api/connectors/:id/apikey
 * Direct API key / bearer token submission for api_key providers.
 * ----------------------------------------------------- */
router.post("/:id/apikey", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });

  const provider = String(req.params.id ?? "");
  if (!isKnownProvider(provider)) {
    return res.status(400).json({ ok: false, error: "UNKNOWN_PROVIDER" });
  }

  const meta = CONNECTOR_CATALOG[provider];
  if (meta.authType !== "api_key") {
    return res.status(400).json({ ok: false, error: "NOT_API_KEY_PROVIDER" });
  }

  const token = String(req.body?.token ?? "").trim();
  if (!token) {
    return res.status(400).json({ ok: false, error: "TOKEN_REQUIRED" });
  }
  if (token.length > 500) {
    return res.status(400).json({ ok: false, error: "TOKEN_TOO_LONG" });
  }

  try {
    await upsertConnector({
      userId,
      provider,
      status: "connected",
      accessTokenPlain: token,
      scopes: meta.scopes,
      displayName: meta.name,
      authType: "bearer",
      serverUrl: null,
    });

    // Auto-sync tools after connecting
    let mcpSession = null;
    try {
      mcpSession = await openUserMcpSession(userId);
      const providerSession = mcpSession.sessions.find((s: any) => s.provider === provider);
      if (providerSession) {
        const row = await findConnector(userId, provider);
        if (row) {
          await syncConnectorTools(userId, row.id, provider, providerSession.tools);
        }
      }
    } catch (syncErr) {
      console.warn(`[connectors] auto-sync failed for ${provider}`, syncErr);
    } finally {
      if (mcpSession) await mcpSession.close();
    }

    return res.json({ ok: true, provider, status: "connected" });
  } catch (err: any) {
    console.error(`[connectors] apikey submit failed for ${provider}`, err);
    return res.status(500).json({ ok: false, error: err?.message ?? "INTERNAL" });
  }
});

/* -------------------------------------------------------
 * POST /api/connectors/custom — Add custom MCP connector
 * ----------------------------------------------------- */
router.post("/custom", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "unauthorized" });

    const { displayName, serverUrl, authType, bearerToken } = req.body;
    if (!displayName || !serverUrl) {
      return res.status(400).json({ error: "displayName and serverUrl are required" });
    }

    // Validate URL
    try {
      const url = new URL(serverUrl);
      if (url.protocol !== "https:" && !url.hostname.startsWith("127.0.0.1") && url.hostname !== "localhost") {
        return res.status(400).json({ error: "serverUrl must use HTTPS" });
      }
    } catch {
      return res.status(400).json({ error: "invalid serverUrl" });
    }

    // Check custom connector limit
    const { rows: existingCustom } = await pgPool.query(
      `SELECT COUNT(*) as cnt FROM user_connectors WHERE user_id = $1 AND is_custom = TRUE`,
      [userId],
    );
    if (Number(existingCustom[0]?.cnt ?? 0) >= 10) {
      return res.status(403).json({ error: "Custom connector limit reached (10)" });
    }

    // Generate unique provider slug
    const slugBody = displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
    if (!slugBody) {
      return res.status(400).json({ error: "displayName must contain at least one alphanumeric character" });
    }
    const slug = "custom_" + slugBody;

    // Check slug collision
    const existing = await findConnector(userId, slug);
    if (existing) {
      return res.status(409).json({ error: "A connector with this name already exists" });
    }

    const tokenPlain = bearerToken || "";
    const effectiveAuthType = authType || (tokenPlain ? "bearer" : "none");
    const connector = await upsertConnector({
      userId,
      provider: slug,
      status: (tokenPlain || effectiveAuthType === "none") ? "connected" : "needs_config",
      accessTokenPlain: tokenPlain,
      serverUrl,
      displayName,
      authType: effectiveAuthType,
      isCustom: true,
    });

    // Try connecting and syncing tools
    let tools: any[] = [];
    if (connector.status === "connected") {
      let session: any = null;
      try {
        session = await openUserMcpSession(userId);
        const providerSession = session.sessions.find((s: any) => s.provider === slug);
        if (providerSession) {
          const syncResult = await syncConnectorTools(userId, connector.id, slug, providerSession.tools);
          tools = syncResult.tools;
        }
      } catch (err) {
        console.warn("[connectors] tool sync failed for custom connector", err);
      } finally {
        if (session) await session.close().catch(() => {});
      }
    }

    return res.json({ connector, tools });
  } catch (err: any) {
    console.error("[connectors] POST /custom error", err);
    return res.status(500).json({ error: err.message });
  }
});

/* -------------------------------------------------------
 * POST /api/connectors/:id/sync — Re-sync tools
 * ----------------------------------------------------- */
router.post("/:id/sync", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "unauthorized" });

    const connectorId = Number(req.params.id);
    if (!Number.isFinite(connectorId) || connectorId <= 0) {
      return res.status(400).json({ error: "invalid connector id" });
    }
    const { rows } = await pgPool.query(
      `SELECT * FROM user_connectors WHERE id = $1 AND user_id = $2`,
      [connectorId, userId],
    );
    if (rows.length === 0) return res.status(404).json({ error: "connector not found" });

    const row = rows[0];
    const session = await openUserMcpSession(userId);
    try {
      const providerSession = session.sessions.find((s: any) => s.provider === row.provider);
      if (!providerSession) {
        return res.status(502).json({ error: "Could not connect to MCP server" });
      }
      const result = await syncConnectorTools(userId, connectorId, row.provider, providerSession.tools);
      return res.json(result);
    } finally {
      await session.close().catch(() => {});
    }
  } catch (err: any) {
    console.error("[connectors] POST /:id/sync error", err);
    return res.status(500).json({ error: err.message });
  }
});

/* -------------------------------------------------------
 * GET /api/connectors/:id/tools — List connector tools
 * ----------------------------------------------------- */
router.get("/:id/tools", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "unauthorized" });

    const connectorId = Number(req.params.id);
    const { rows } = await pgPool.query(
      `SELECT * FROM user_connector_tools WHERE user_id = $1 AND connector_id = $2 ORDER BY tool_name ASC`,
      [userId, connectorId],
    );
    return res.json({ tools: rows.map(mapToolRow) });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/* -------------------------------------------------------
 * PATCH /api/connectors/:id/tools/:tid — Toggle tool enabled
 * ----------------------------------------------------- */
router.patch("/:id/tools/:tid", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "unauthorized" });

    const toolId = Number(req.params.tid);
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be boolean" });
    }

    const { rowCount } = await pgPool.query(
      `UPDATE user_connector_tools SET enabled = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3`,
      [enabled, toolId, userId],
    );
    if (rowCount === 0) return res.status(404).json({ error: "tool not found" });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/* -------------------------------------------------------
 * PATCH /api/connectors/:id/toggle — Toggle connector chat enabled
 * ----------------------------------------------------- */
router.patch("/:id/toggle", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "unauthorized" });

    const connectorId = Number(req.params.id);
    const { chatEnabled } = req.body;
    if (typeof chatEnabled !== "boolean") {
      return res.status(400).json({ error: "chatEnabled must be boolean" });
    }

    await pgPool.query(
      `INSERT INTO user_connector_toggles (user_id, connector_id, chat_enabled, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, connector_id) DO UPDATE SET chat_enabled = EXCLUDED.chat_enabled, updated_at = NOW()`,
      [userId, connectorId, chatEnabled],
    );
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
