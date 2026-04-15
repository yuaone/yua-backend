// src/routes/skills-router.ts
//
// Phase D.6 — Skills REST API.
//
// Endpoints:
//   GET    /api/skills              → list installed skills for the user
//   GET    /api/skills/directory    → browse the skill directory
//   GET    /api/skills/:id          → single installed skill (incl. markdown)
//   POST   /api/skills              → create a user-authored skill
//   POST   /api/skills/install      → install a directory skill by slug
//   PATCH  /api/skills/:id          → toggle enabled / edit markdown
//   DELETE /api/skills/:id          → uninstall (user-authored only)
//
// Auth: mounted behind `requireFirebaseAuth`. Writes are fail-soft —
// a broken toggle or insert never breaks the chat path.

import { Router, type Request, type Response } from "express";
import {
  createUserSkill,
  deleteUserSkill,
  findDirectoryBySlug,
  getSkillById,
  listDirectory,
  listInstalledSkills,
  updateUserSkill,
} from "../skills/skills-registry";

const router = Router();

function getUserId(req: Request): number | null {
  const raw = (req as any).user?.userId ?? (req as any).user?.id;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/* GET /api/skills */
router.get("/", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    const skills = await listInstalledSkills(userId);
    return res.json({ ok: true, skills });
  } catch (err: any) {
    return res
      .status(500)
      .json({ ok: false, error: "internal_error", detail: err?.message });
  }
});

/* GET /api/skills/directory */
router.get("/directory", async (_req: Request, res: Response) => {
  try {
    const entries = listDirectory();
    return res.json({ ok: true, entries });
  } catch (err: any) {
    return res
      .status(500)
      .json({ ok: false, error: "internal_error", detail: err?.message });
  }
});

/* POST /api/skills — create a user-authored skill */
router.post("/", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });
  const body = req.body ?? {};
  const skill = await createUserSkill(userId, {
    slug: body.slug ?? body.name,
    name: body.name,
    description: body.description,
    markdown: body.markdown,
    allowedTools: body.allowedTools ?? body.allowed_tools,
    trigger: body.trigger,
    license: body.license,
    version: body.version,
  });
  if (!skill) return res.status(400).json({ ok: false, error: "invalid_input" });
  return res.json({ ok: true, skill });
});

/* POST /api/skills/install — install from directory */
router.post("/install", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });
  const slug = String(req.body?.slug ?? "").trim();
  if (!slug) return res.status(400).json({ ok: false, error: "slug_required" });
  const found = findDirectoryBySlug(slug);
  if (!found) return res.status(404).json({ ok: false, error: "unknown_skill" });
  return res.json({ ok: true, skill: { ...found, enabled: true } });
});

/* GET /api/skills/:id */
router.get("/:id", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });
  const skill = await getSkillById(userId, String(req.params.id ?? ""));
  if (!skill) return res.status(404).json({ ok: false, error: "not_found" });
  return res.json({ ok: true, skill });
});

/* PATCH /api/skills/:id — edit or toggle */
router.patch("/:id", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });
  const id = String(req.params.id ?? "");
  const body = req.body ?? {};
  const updated = await updateUserSkill(userId, id, {
    name: body.name,
    description: body.description,
    markdown: body.markdown,
    allowedTools: body.allowedTools ?? body.allowed_tools,
    trigger: body.trigger,
    enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
  });
  if (!updated) return res.status(404).json({ ok: false, error: "not_found" });
  return res.json({ ok: true, skill: updated });
});

/* DELETE /api/skills/:id — delete user-authored */
router.delete("/:id", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });
  const id = String(req.params.id ?? "");
  if (id.startsWith("builtin.")) {
    return res
      .status(409)
      .json({ ok: false, error: "cannot_delete_builtin" });
  }
  const ok = await deleteUserSkill(userId, id);
  if (!ok) return res.status(404).json({ ok: false, error: "not_found" });
  return res.json({ ok: true });
});

export default router;
