import { Request, Response } from "express";

let ENGINE_MODE: "dev" | "prod" = "prod";
let ENGINE_MEMORY: any = {};

export const EngineController = {
  // -------------------------------------------------------------
  // 상태 체크
  // -------------------------------------------------------------
  status: async (_req: Request, res: Response) => {
    return res.json({
      ok: true,
      engine: "YUA-AI Core",
      status: "running",
      provider: ENGINE_MODE,
      timestamp: new Date().toISOString(),
    });
  },

  // -------------------------------------------------------------
  // Memory Reset
  // -------------------------------------------------------------
  memoryReset: async (_req: Request, res: Response) => {
    ENGINE_MEMORY = {};
    return res.json({ ok: true, message: "memory cleared" });
  },

  // -------------------------------------------------------------
  // MODE 변경
  // -------------------------------------------------------------
  setMode: async (req: Request, res: Response) => {
    const { mode } = req.body;
    if (!["dev", "prod"].includes(mode)) {
      return res.status(400).json({ ok: false, error: "Invalid mode" });
    }
    ENGINE_MODE = mode;
    return res.json({ ok: true, mode: ENGINE_MODE });
  },

};
