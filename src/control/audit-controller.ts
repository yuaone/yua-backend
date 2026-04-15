// 📂 src/controllers/audit-controller.ts
// 🔥 AuditController — FINAL

import { Request, Response } from "express";

export const auditController = {
  async search(req: Request, res: Response) {
    try {
      const workspaceRole = req.workspace?.role;
      if (workspaceRole !== "owner" && workspaceRole !== "admin") {
        return res.status(403).json({
          ok: false,
          engine: "audit-error",
          error: "admin_required",
        });
      }

      const queryRaw = typeof req.body?.query === "string" ? req.body.query.trim() : "";

      if (queryRaw.length === 0) {
        return res.status(200).json({
          ok: true,
          engine: "audit",
          result: [],
        });
      }
      if (queryRaw.length > 500) {
        return res.status(400).json({
          ok: false,
          engine: "audit-error",
          error: "query_too_long",
        });
      }

      return res.status(200).json({
        ok: true,
        engine: "audit",
        result: [],
        warning: "workspace_scoped_audit_search_not_ready",
      });
    } catch (e: any) {
      return res.status(500).json({
        ok: false,
        engine: "audit-error",
        error: "internal_error",
      });
    }
  },
};
