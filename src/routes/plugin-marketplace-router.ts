// src/routes/plugin-marketplace-router.ts
// Plugin Marketplace REST API Router
//
// GET  /search          — Search marketplace plugins
// GET  /installed       — List user's installed plugins
// GET  /:name           — Get plugin details
// GET  /:name/reviews   — Get plugin reviews
// POST /install         — Install a plugin
// DELETE /uninstall     — Uninstall a plugin
// POST /publish         — Publish a new plugin version
// POST /:name/reviews   — Submit a review
// PATCH /toggle         — Enable/disable a plugin

import { Router, Request, Response } from "express";
import { pgPool } from "../db/postgres";

const router = Router();

/* ==================================================
   Helpers
================================================== */

/** Validate semver format (strict: major.minor.patch) */
function isValidSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/.test(v);
}

/** Clamp and parse pagination params */
function parsePagination(query: { page?: string; limit?: string }): {
  page: number;
  limit: number;
  offset: number;
} {
  let page = parseInt(query.page ?? "1", 10);
  let limit = parseInt(query.limit ?? "20", 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!Number.isFinite(limit) || limit < 1) limit = 20;
  if (limit > 100) limit = 100;
  return { page, limit, offset: (page - 1) * limit };
}

/* ==================================================
   GET /search — Search marketplace plugins
================================================== */
/**
 * @description Search plugins in the marketplace by name, description, category, or trust level.
 * @query q - Search term (ILIKE on name and description)
 * @query category - Filter by category
 * @query trustLevel - Filter by trust_level
 * @query page - Page number (default 1)
 * @query limit - Results per page (default 20, max 100)
 */
router.get("/search", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ ok: false, error: "auth_required" });
      return;
    }

    const { page, limit, offset } = parsePagination(
      req.query as { page?: string; limit?: string }
    );
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const category =
      typeof req.query.category === "string"
        ? req.query.category.trim()
        : null;
    const trustLevel =
      typeof req.query.trustLevel === "string"
        ? req.query.trustLevel.trim()
        : null;

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 0;

    if (q) {
      paramIdx++;
      const likeParam = `%${q}%`;
      conditions.push(
        `(pr.name ILIKE $${paramIdx} OR pr.description ILIKE $${paramIdx})`
      );
      params.push(likeParam);
    }
    if (category) {
      paramIdx++;
      conditions.push(`pr.category = $${paramIdx}`);
      params.push(category);
    }
    if (trustLevel) {
      paramIdx++;
      conditions.push(`pr.trust_level = $${paramIdx}`);
      params.push(trustLevel);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Count total
    const countResult = await pgPool.query(
      `SELECT COUNT(*)::int AS total FROM plugin_registry pr ${whereClause}`,
      params
    );
    const total: number = countResult.rows[0]?.total ?? 0;

    // Fetch page
    const dataParams = [...params, limit, offset];
    const dataResult = await pgPool.query(
      `SELECT pr.*
       FROM plugin_registry pr
       ${whereClause}
       ORDER BY pr.total_downloads DESC, pr.created_at DESC
       LIMIT $${paramIdx + 1} OFFSET $${paramIdx + 2}`,
      dataParams
    );

    res.status(200).json({
      ok: true,
      plugins: dataResult.rows,
      total,
      page,
      limit,
    });
  } catch (err: any) {
    console.error("[PLUGIN_MARKETPLACE] /search error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

/* ==================================================
   GET /installed — List user's installed plugins
================================================== */
/**
 * @description List all plugins installed by the current user.
 */
router.get("/installed", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ ok: false, error: "auth_required" });
      return;
    }

    const result = await pgPool.query(
      `SELECT up.*, pr.name, pr.description, pr.category, pr.trust_level,
              pr.author, pr.avg_rating, pr.total_reviews, pr.total_downloads
       FROM user_plugins up
       JOIN plugin_registry pr ON pr.name = up.plugin_name
       WHERE up.user_id = $1
       ORDER BY up.installed_at DESC`,
      [userId]
    );

    res.status(200).json({
      ok: true,
      plugins: result.rows,
    });
  } catch (err: any) {
    console.error("[PLUGIN_MARKETPLACE] /installed error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

/* ==================================================
   GET /:name — Get plugin details
================================================== */
/**
 * @description Get full details for a plugin including versions and review stats.
 * @param name - URL-encoded plugin name (e.g. @yuaone%2Fplugin-typescript)
 */
router.get("/:name", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ ok: false, error: "auth_required" });
      return;
    }

    const pluginName = decodeURIComponent(req.params.name);
    if (!pluginName) {
      res.status(400).json({ ok: false, error: "plugin name is required" });
      return;
    }

    // Plugin details
    const pluginResult = await pgPool.query(
      `SELECT * FROM plugin_registry WHERE name = $1`,
      [pluginName]
    );
    if (pluginResult.rows.length === 0) {
      res.status(404).json({ ok: false, error: "plugin_not_found" });
      return;
    }
    const plugin = pluginResult.rows[0];

    // Versions
    const versionsResult = await pgPool.query(
      `SELECT * FROM plugin_versions
       WHERE plugin_id = $1
       ORDER BY created_at DESC`,
      [plugin.id]
    );

    // Review stats
    const reviewStats = await pgPool.query(
      `SELECT COALESCE(AVG(rating), 0)::numeric(3,2) AS avg,
              COUNT(*)::int AS total
       FROM plugin_reviews
       WHERE plugin_id = $1`,
      [plugin.id]
    );

    res.status(200).json({
      ok: true,
      plugin,
      versions: versionsResult.rows,
      reviews: {
        avg: parseFloat(reviewStats.rows[0]?.avg ?? "0"),
        total: reviewStats.rows[0]?.total ?? 0,
      },
    });
  } catch (err: any) {
    console.error("[PLUGIN_MARKETPLACE] /:name error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

/* ==================================================
   POST /install — Install a plugin for the user
================================================== */
/**
 * @description Install a plugin (optionally a specific version) for the current user.
 * @body pluginName - Plugin name
 * @body version - Optional version (defaults to latest)
 */
router.post("/install", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ ok: false, error: "auth_required" });
      return;
    }

    const { pluginName, version } = req.body ?? {};

    if (!pluginName || typeof pluginName !== "string") {
      res.status(400).json({ ok: false, error: "pluginName is required" });
      return;
    }

    // Check plugin exists
    const pluginResult = await pgPool.query(
      `SELECT id, name FROM plugin_registry WHERE name = $1`,
      [pluginName]
    );
    if (pluginResult.rows.length === 0) {
      res.status(404).json({ ok: false, error: "plugin_not_found" });
      return;
    }
    const plugin = pluginResult.rows[0];

    // Resolve version
    let resolvedVersion: string;
    if (version && typeof version === "string") {
      const versionResult = await pgPool.query(
        `SELECT version FROM plugin_versions WHERE plugin_id = $1 AND version = $2`,
        [plugin.id, version]
      );
      if (versionResult.rows.length === 0) {
        res.status(404).json({ ok: false, error: "version_not_found" });
        return;
      }
      resolvedVersion = version;
    } else {
      // Get latest version
      const latestResult = await pgPool.query(
        `SELECT version FROM plugin_versions
         WHERE plugin_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [plugin.id]
      );
      if (latestResult.rows.length === 0) {
        res.status(404).json({ ok: false, error: "no_versions_available" });
        return;
      }
      resolvedVersion = latestResult.rows[0].version;
    }

    // Insert into user_plugins (upsert to handle re-install)
    await pgPool.query(
      `INSERT INTO user_plugins (user_id, plugin_name, version, is_enabled, installed_at)
       VALUES ($1, $2, $3, true, NOW())
       ON CONFLICT (user_id, plugin_name)
       DO UPDATE SET version = $3, is_enabled = true, installed_at = NOW()`,
      [userId, pluginName, resolvedVersion]
    );

    // Increment download count
    await pgPool.query(
      `UPDATE plugin_registry SET total_downloads = total_downloads + 1 WHERE id = $1`,
      [plugin.id]
    );

    res.status(200).json({
      ok: true,
      installed: true,
      plugin: { name: pluginName, version: resolvedVersion },
    });
  } catch (err: any) {
    console.error("[PLUGIN_MARKETPLACE] /install error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

/* ==================================================
   DELETE /uninstall — Uninstall a plugin
================================================== */
/**
 * @description Uninstall a plugin for the current user.
 * @body pluginName - Plugin name to uninstall
 */
router.delete("/uninstall", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ ok: false, error: "auth_required" });
      return;
    }

    const { pluginName } = req.body ?? {};
    if (!pluginName || typeof pluginName !== "string") {
      res.status(400).json({ ok: false, error: "pluginName is required" });
      return;
    }

    const result = await pgPool.query(
      `DELETE FROM user_plugins WHERE user_id = $1 AND plugin_name = $2`,
      [userId, pluginName]
    );

    if (result.rowCount === 0) {
      res.status(404).json({ ok: false, error: "plugin_not_installed" });
      return;
    }

    res.status(200).json({ ok: true, uninstalled: true });
  } catch (err: any) {
    console.error("[PLUGIN_MARKETPLACE] /uninstall error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

/* ==================================================
   POST /publish — Publish a new plugin version (author only)
================================================== */
/**
 * @description Publish a new version of a plugin. Creates the plugin registry entry if it doesn't exist.
 * @body name - Plugin name (e.g. @yuaone/plugin-typescript)
 * @body version - Semver version string
 * @body manifest - JSON manifest object
 * @body changelog - Optional changelog text
 */
router.post("/publish", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ ok: false, error: "auth_required" });
      return;
    }

    const { name, version, manifest, changelog } = req.body ?? {};

    if (!name || typeof name !== "string") {
      res.status(400).json({ ok: false, error: "name is required" });
      return;
    }
    if (!version || typeof version !== "string") {
      res.status(400).json({ ok: false, error: "version is required" });
      return;
    }
    if (!isValidSemver(version)) {
      res.status(400).json({
        ok: false,
        error: "invalid_version",
        message: "Version must be valid semver (e.g. 1.0.0)",
      });
      return;
    }
    if (!manifest || typeof manifest !== "object") {
      res.status(400).json({ ok: false, error: "manifest is required and must be a JSON object" });
      return;
    }

    // Upsert plugin_registry (create if new, verify author if existing)
    const existingPlugin = await pgPool.query(
      `SELECT id, author_id FROM plugin_registry WHERE name = $1`,
      [name]
    );

    let pluginId: number;

    if (existingPlugin.rows.length > 0) {
      // Verify author ownership
      if (existingPlugin.rows[0].author_id !== userId) {
        res.status(403).json({
          ok: false,
          error: "forbidden",
          message: "Only the plugin author can publish new versions",
        });
        return;
      }
      pluginId = existingPlugin.rows[0].id;
    } else {
      // Create new plugin registry entry
      const insertResult = await pgPool.query(
        `INSERT INTO plugin_registry (name, author_id, description, manifest, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         RETURNING id`,
        [name, userId, manifest.description ?? "", JSON.stringify(manifest)]
      );
      pluginId = insertResult.rows[0].id;
    }

    // Check version doesn't already exist
    const existingVersion = await pgPool.query(
      `SELECT id FROM plugin_versions WHERE plugin_id = $1 AND version = $2`,
      [pluginId, version]
    );
    if (existingVersion.rows.length > 0) {
      res.status(409).json({
        ok: false,
        error: "version_exists",
        message: `Version ${version} already exists for plugin ${name}`,
      });
      return;
    }

    // Insert version
    await pgPool.query(
      `INSERT INTO plugin_versions (plugin_id, version, manifest, changelog, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [pluginId, version, JSON.stringify(manifest), changelog ?? null]
    );

    // Update plugin_registry latest version and updated_at
    await pgPool.query(
      `UPDATE plugin_registry SET latest_version = $1, manifest = $2, updated_at = NOW() WHERE id = $3`,
      [version, JSON.stringify(manifest), pluginId]
    );

    res.status(200).json({
      ok: true,
      published: true,
      version,
    });
  } catch (err: any) {
    console.error("[PLUGIN_MARKETPLACE] /publish error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

/* ==================================================
   GET /:name/reviews — Get plugin reviews
================================================== */
/**
 * @description Get paginated reviews for a plugin.
 * @param name - URL-encoded plugin name
 * @query page - Page number (default 1)
 * @query limit - Results per page (default 20, max 100)
 * @query sort - Sort order: recent | helpful | rating (default recent)
 */
router.get("/:name/reviews", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ ok: false, error: "auth_required" });
      return;
    }

    const pluginName = decodeURIComponent(req.params.name);
    if (!pluginName) {
      res.status(400).json({ ok: false, error: "plugin name is required" });
      return;
    }

    // Get plugin id
    const pluginResult = await pgPool.query(
      `SELECT id FROM plugin_registry WHERE name = $1`,
      [pluginName]
    );
    if (pluginResult.rows.length === 0) {
      res.status(404).json({ ok: false, error: "plugin_not_found" });
      return;
    }
    const pluginId = pluginResult.rows[0].id;

    const { page, limit, offset } = parsePagination(
      req.query as { page?: string; limit?: string }
    );

    const sort = typeof req.query.sort === "string" ? req.query.sort : "recent";
    let orderBy: string;
    switch (sort) {
      case "helpful":
        orderBy = "r.helpful_count DESC, r.created_at DESC";
        break;
      case "rating":
        orderBy = "r.rating DESC, r.created_at DESC";
        break;
      case "recent":
      default:
        orderBy = "r.created_at DESC";
        break;
    }

    const countResult = await pgPool.query(
      `SELECT COUNT(*)::int AS total FROM plugin_reviews WHERE plugin_id = $1`,
      [pluginId]
    );
    const total: number = countResult.rows[0]?.total ?? 0;

    const reviewsResult = await pgPool.query(
      `SELECT r.*
       FROM plugin_reviews r
       WHERE r.plugin_id = $1
       ORDER BY ${orderBy}
       LIMIT $2 OFFSET $3`,
      [pluginId, limit, offset]
    );

    res.status(200).json({
      ok: true,
      reviews: reviewsResult.rows,
      total,
      page,
      limit,
    });
  } catch (err: any) {
    console.error("[PLUGIN_MARKETPLACE] /:name/reviews GET error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

/* ==================================================
   POST /:name/reviews — Submit a review
================================================== */
/**
 * @description Submit or update a review for a plugin (one review per user per plugin).
 * @param name - URL-encoded plugin name
 * @body rating - Rating 1-5
 * @body title - Optional review title
 * @body body - Optional review body
 */
router.post("/:name/reviews", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ ok: false, error: "auth_required" });
      return;
    }

    const pluginName = decodeURIComponent(req.params.name);
    if (!pluginName) {
      res.status(400).json({ ok: false, error: "plugin name is required" });
      return;
    }

    const { rating, title, body: reviewBody } = req.body ?? {};

    if (typeof rating !== "number" || rating < 1 || rating > 5 || !Number.isInteger(rating)) {
      res.status(400).json({
        ok: false,
        error: "rating must be an integer between 1 and 5",
      });
      return;
    }

    // Get plugin id
    const pluginResult = await pgPool.query(
      `SELECT id FROM plugin_registry WHERE name = $1`,
      [pluginName]
    );
    if (pluginResult.rows.length === 0) {
      res.status(404).json({ ok: false, error: "plugin_not_found" });
      return;
    }
    const pluginId = pluginResult.rows[0].id;

    // Upsert review (one per user per plugin)
    const reviewResult = await pgPool.query(
      `INSERT INTO plugin_reviews (plugin_id, user_id, rating, title, body, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (plugin_id, user_id)
       DO UPDATE SET rating = $3, title = $4, body = $5, updated_at = NOW()
       RETURNING *`,
      [pluginId, userId, rating, title ?? null, reviewBody ?? null]
    );

    // Update plugin_registry aggregate rating
    await pgPool.query(
      `UPDATE plugin_registry
       SET avg_rating = (SELECT COALESCE(AVG(rating), 0) FROM plugin_reviews WHERE plugin_id = $1),
           total_reviews = (SELECT COUNT(*) FROM plugin_reviews WHERE plugin_id = $1),
           updated_at = NOW()
       WHERE id = $1`,
      [pluginId]
    );

    res.status(200).json({
      ok: true,
      review: reviewResult.rows[0],
    });
  } catch (err: any) {
    console.error("[PLUGIN_MARKETPLACE] /:name/reviews POST error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

/* ==================================================
   PATCH /toggle — Enable/disable a plugin
================================================== */
/**
 * @description Enable or disable an installed plugin for the current user.
 * @body pluginName - Plugin name
 * @body enabled - Boolean to enable/disable
 */
router.patch("/toggle", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ ok: false, error: "auth_required" });
      return;
    }

    const { pluginName, enabled } = req.body ?? {};

    if (!pluginName || typeof pluginName !== "string") {
      res.status(400).json({ ok: false, error: "pluginName is required" });
      return;
    }
    if (typeof enabled !== "boolean") {
      res.status(400).json({ ok: false, error: "enabled must be a boolean" });
      return;
    }

    const result = await pgPool.query(
      `UPDATE user_plugins SET is_enabled = $1 WHERE user_id = $2 AND plugin_name = $3`,
      [enabled, userId, pluginName]
    );

    if (result.rowCount === 0) {
      res.status(404).json({ ok: false, error: "plugin_not_installed" });
      return;
    }

    res.status(200).json({ ok: true, toggled: true, enabled });
  } catch (err: any) {
    console.error("[PLUGIN_MARKETPLACE] /toggle error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

export default router;
