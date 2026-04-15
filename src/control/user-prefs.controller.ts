// 📂 src/control/user-prefs.controller.ts
// Settings v2 — user-scoped preference bag (JSONB-backed).
// Only whitelisted keys are accepted. Unknown keys are dropped silently.
// Validation: strings ≤ 2000 chars, booleans, integers ≤ 100_000_000 cents.
import { Request, Response } from "express";
import { getUserPrefs, mergeUserPrefs } from "../db/repo/user-prefs.repo";

/* =========================
   Whitelist + validators
========================= */

type FieldKind = "string" | "boolean" | "int";

const FIELDS: Record<string, FieldKind> = {
  nickname: "string",
  jobRole: "string",
  personalization: "string",
  notifResponseComplete: "boolean",
  notifEmailSummary: "boolean",
  notifImportant: "boolean",
  monthlyCapCents: "int",
  autoTopupEnabled: "boolean",
  autoTopupThresholdCents: "int",
  autoTopupAmountCents: "int",
};

const MAX_STRING_LEN = 2000;
const MAX_INT_CENTS = 100_000_000;

function coerce(kind: FieldKind, v: unknown): unknown | undefined {
  if (v === null) return null;
  if (kind === "string") {
    if (typeof v !== "string") return undefined;
    // Truncate rather than reject — guards against accidental overflow.
    return v.length > MAX_STRING_LEN ? v.slice(0, MAX_STRING_LEN) : v;
  }
  if (kind === "boolean") {
    if (typeof v !== "boolean") return undefined;
    return v;
  }
  if (kind === "int") {
    if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
    const n = Math.trunc(v);
    if (n < 0 || n > MAX_INT_CENTS) return undefined;
    return n;
  }
  return undefined;
}

function sanitize(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, kind] of Object.entries(FIELDS)) {
    if (!(k in (body as Record<string, unknown>))) continue;
    const raw = (body as Record<string, unknown>)[k];
    const val = coerce(kind, raw);
    if (val !== undefined) out[k] = val;
  }
  return out;
}

/* =========================
   Controllers
========================= */

export async function getUserPrefsController(req: Request, res: Response) {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  try {
    const prefs = await getUserPrefs(userId);
    return res.json({ ok: true, prefs });
  } catch (err: any) {
    console.error("❌ GET /me/prefs error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "user_prefs_read_failed" });
  }
}

export async function postUserPrefsController(req: Request, res: Response) {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const patch = sanitize(req.body);
  if (Object.keys(patch).length === 0) {
    // Still return current prefs so the client can re-sync.
    try {
      const prefs = await getUserPrefs(userId);
      return res.json({ ok: true, prefs });
    } catch (err: any) {
      console.error("❌ POST /me/prefs (empty patch) error:", err);
      return res
        .status(500)
        .json({ ok: false, error: "user_prefs_write_failed" });
    }
  }

  try {
    const prefs = await mergeUserPrefs(userId, patch);
    return res.json({ ok: true, prefs });
  } catch (err: any) {
    console.error("❌ POST /me/prefs error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "user_prefs_write_failed" });
  }
}
