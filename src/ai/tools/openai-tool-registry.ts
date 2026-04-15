import type { ToolType } from "./tool-types";

/* ===========================================================
   Types
=========================================================== */

export type OpenAIToolName =
  | "web_search"
  | "web_fetch"
  | "extract_numbers"
  | "python_visualize"
  | "analyze_image"
  | "analyze_csv"
  // Phase 2 W3 — YUA internal capability tools
  | "memory_append"
  | "activate_skill"
  // Phase 2 W2 — YUA artifact streaming tools
  | "artifact_create"
  | "artifact_update";

export type OpenAIToolExecutionResult = {
  ok: boolean;
  output?: unknown;
  error?: string;
  size?: number;
};

export type OpenAIToolHandlerContext = {
  traceId?: string;
  allowSearch: boolean;
  /** Required for memory_append + activate_skill (per-user write path). */
  userId?: number;
  threadId?: number;
};

export type OpenAIToolDefinition = {
  name: OpenAIToolName;
  description: string;
  parameters: Record<string, unknown>;
  executionHandler: (
    args: Record<string, unknown>,
    ctx: OpenAIToolHandlerContext
  ) => Promise<OpenAIToolExecutionResult>;
};

/* ===========================================================
   Registry
=========================================================== */

const registry: Record<OpenAIToolName, OpenAIToolDefinition> = {
  /* ---------------- web_search ---------------- */

  web_search: {
    name: "web_search",
    description:
      "Search the web for up-to-date information and return ranked results with evidence.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        max_results: { type: "integer", minimum: 1, maximum: 8 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    executionHandler: async (args, ctx) => {
      if (!ctx.allowSearch) {
        return { ok: false, error: "ALLOW_SEARCH_FALSE" };
      }

      const query = String(args.query ?? "").trim();
      if (!query) return { ok: false, error: "EMPTY_QUERY" };

      return {
        ok: false,
        error: "OPENAI_NATIVE_WEB_SEARCH_UNSUPPORTED",
      };
    },
  },

  /* ---------------- web_fetch ---------------- */

  web_fetch: {
    name: "web_fetch",
    description:
      "Fetch a single URL (read-only) and return extracted text content.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    executionHandler: async (args, ctx) => {
      if (!ctx.allowSearch) {
        return { ok: false, error: "ALLOW_SEARCH_FALSE" };
      }

      const url = String(args.url ?? "").trim();
      if (!url) return { ok: false, error: "EMPTY_URL" };

      return {
        ok: false,
        error: "OPENAI_NATIVE_WEB_FETCH_UNSUPPORTED",
      };
    },
  },

  /* ---------------- extract_numbers ---------------- */

  extract_numbers: {
    name: "extract_numbers",
    description:
      "Extract numeric values from text and label them if possible.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        label: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    },
    executionHandler: async (args) => {
      const text = String(args.text ?? "");
      const matches = text.match(/-?\d+(\.\d+)?/g) ?? [];
      const numbers = matches
        .map((m) => Number(m))
        .filter((n) => Number.isFinite(n));

      return {
        ok: true,
        output: {
          label: typeof args.label === "string" ? args.label : undefined,
          numbers,
        },
        size: numbers.length,
      };
    },
  },

  /* ---------------- python_visualize (stub) ---------------- */

  python_visualize: {
    name: "python_visualize",
    description:
      "Optional future: generate a visualization spec from numeric data.",
    parameters: {
      type: "object",
      properties: {
        spec: { type: "string" },
        data: { type: "string" },
      },
      required: ["spec", "data"],
      additionalProperties: false,
    },
    executionHandler: async () => {
      return { ok: false, error: "NOT_IMPLEMENTED" };
    },
  },

  /* ---------------- analyze_image ---------------- */

  analyze_image: {
    name: "analyze_image",
    description:
      "Analyze an uploaded image in detail. Describe contents, extract text (OCR), identify objects, read charts/graphs, and provide structured observations.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to focus on when analyzing the image",
        },
        detail: {
          type: "string",
          enum: ["auto", "low", "high"],
          description: "Image analysis detail level",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    executionHandler: async (args) => {
      // Executed via VisionEngine in ExecutionEngine, not here
      return {
        ok: true,
        output: {
          query: String(args.query ?? ""),
          detail: String(args.detail ?? "auto"),
          status: "DELEGATED_TO_VISION_ENGINE",
        },
      };
    },
  },

  /* ---------------- analyze_csv ---------------- */

  analyze_csv: {
    name: "analyze_csv",
    description:
      "Analyze uploaded CSV or tabular data. Parse structure, compute statistics, identify patterns, and return a preview with summary.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to analyze in the data",
        },
        format: {
          type: "string",
          enum: ["csv", "tsv", "json"],
          description: "Data format hint",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    executionHandler: async (args) => {
      // Executed via FileAnalyzerEngine in ExecutionEngine
      return {
        ok: true,
        output: {
          query: String(args.query ?? ""),
          format: String(args.format ?? "csv"),
          status: "DELEGATED_TO_FILE_ANALYZER",
        },
      };
    },
  },

  /* ---------------- memory_append ---------------- */

  memory_append: {
    name: "memory_append",
    description:
      "Save a durable fact to the user's persistent memory. Use when the user shares a preference, a project fact, a constraint, or an explicit 'remember this' request. Never save secrets, ephemeral task state, or anything derivable from the current files/git. Appends to an existing section if the section name matches; creates the section if missing.",
    parameters: {
      type: "object",
      properties: {
        section: {
          type: "string",
          description:
            "Markdown H2 section name to append under. Use existing sections like 'About me', 'Preferences', 'Current projects', 'Do not' when possible. Create new section names only for topics the existing ones don't cover.",
        },
        content: {
          type: "string",
          description:
            "The fact to remember. One sentence, no more than 200 characters. Do NOT include the leading '-' bullet marker — the server adds it.",
        },
      },
      required: ["section", "content"],
      additionalProperties: false,
    },
    executionHandler: async (args, ctx) => {
      const section = String((args as any).section ?? "").trim();
      const content = String((args as any).content ?? "").trim();
      const uid = typeof ctx.userId === "number" ? ctx.userId : null;
      if (!uid) return { ok: false, error: "USER_ID_MISSING" };
      if (!section || !content) {
        return { ok: false, error: "SECTION_AND_CONTENT_REQUIRED" };
      }
      try {
        const { pgPool } = await import("../../db/postgres.js");
        const { appendToSection } =
          await import("../../routes/memory-md-helpers.js");
        const prev = await pgPool.query<{ markdown: string }>(
          `SELECT markdown FROM user_memory_md WHERE user_id = $1`,
          [uid],
        );
        const existing = prev.rows[0]?.markdown ?? "";
        const merged = appendToSection(existing, section, content);
        if (merged === existing) {
          return { ok: true, output: { dedup: true, section, content } };
        }
        if (merged.length > 64 * 1024) {
          return { ok: false, error: "MEMORY_CAP_EXCEEDED" };
        }
        await pgPool.query(
          `INSERT INTO user_memory_md (user_id, markdown)
             VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE
               SET markdown = EXCLUDED.markdown, updated_at = NOW()`,
          [uid, merged],
        );
        return { ok: true, output: { section, content, saved: true } };
      } catch (err: any) {
        console.warn("[tool:memory_append] failed", err);
        return { ok: false, error: err?.message ?? "INTERNAL" };
      }
    },
  },

  /* ---------------- artifact_create ---------------- */

  artifact_create: {
    name: "artifact_create",
    description:
      "Create a rich visual artifact (HTML document, Mermaid diagram, Vega-Lite chart, CSV, SVG, or Markdown report) that opens in the user's FileDrawer side panel. Use this INSTEAD of dumping long content, tables, diagrams, or charts into the chat body. The drawer renders the artifact in real time as you stream content via artifact_update. When the user asks for a report, dashboard, diagram, visualization, table with >5 rows, chart, or any output that benefits from a dedicated rendering surface, call this tool FIRST to open the drawer, then stream content with artifact_update. Returns an artifact id for subsequent updates.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: [
            "html",
            "mermaid",
            "vega-lite",
            "svg",
            "csv",
          ],
          description:
            "Format of the artifact. `html` for rich documents/reports with layout/CSS. `mermaid` for flowcharts, sequence diagrams, gantt, ER, class, state, mindmap. `vega-lite` for data charts (bar/line/scatter/heatmap). `svg` for hand-authored inline graphics. `csv` for tabular data the user will export. Do NOT use artifact_create for markdown prose or code — put those directly in the message body.",
        },
        title: {
          type: "string",
          description:
            "Short user-facing title shown in the drawer header and inline card. Max 120 chars. Korean or English, match the user's language.",
        },
        content: {
          type: "string",
          description:
            "Initial content body. For html send the full `<!DOCTYPE html>...</html>` document. For mermaid send only the diagram code (no fences). For vega-lite send the JSON spec as a string. For csv send the comma-separated rows. Aim for a complete document on the first call — use artifact_update only if you need to incrementally build.",
        },
        language: {
          type: "string",
          description:
            "For kind=code: the source language slug (typescript, python, rust, etc.). Ignored for other kinds.",
        },
      },
      required: ["kind", "title", "content"],
      additionalProperties: false,
    },
    executionHandler: async (args, ctx) => {
      const kind = String((args as any).kind ?? "").trim();
      const title = String((args as any).title ?? "").slice(0, 120).trim();
      const content = String((args as any).content ?? "");
      const language = String((args as any).language ?? "").slice(0, 30);
      const uid = typeof ctx.userId === "number" ? ctx.userId : null;
      if (!uid) return { ok: false, error: "USER_ID_MISSING" };
      if (!kind || !title || !content) {
        return { ok: false, error: "KIND_TITLE_CONTENT_REQUIRED" };
      }
      try {
        const { pgPool } = await import("../../db/postgres.js");
        const crypto = await import("node:crypto");
        const id = `art_${crypto.randomBytes(8).toString("hex")}`;
        const mime =
          kind === "html"
            ? "text/html"
            : kind === "markdown"
              ? "text/markdown"
              : kind === "csv"
                ? "text/csv"
                : kind === "svg"
                  ? "image/svg+xml"
                  : kind === "mermaid"
                    ? "text/x-mermaid"
                    : kind === "vega-lite"
                      ? "application/vnd.vegalite+json"
                      : "text/plain";
        await pgPool.query(
          `INSERT INTO artifacts (
             id, user_id, thread_id, kind, title, mime, content,
             size_bytes, status, completed_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'complete', NOW())`,
          [
            id,
            uid,
            ctx.threadId ?? null,
            kind,
            title,
            mime,
            content,
            Buffer.byteLength(content, "utf8"),
          ],
        );
        console.log("[tool:artifact_create]", {
          userId: uid,
          threadId: ctx.threadId,
          id,
          kind,
          title: title.slice(0, 60),
          bytes: Buffer.byteLength(content, "utf8"),
        });
        return {
          ok: true,
          output: { id, kind, title, mime, language },
        };
      } catch (err: any) {
        console.warn("[tool:artifact_create] failed", err);
        return { ok: false, error: err?.message ?? "INTERNAL" };
      }
    },
  },

  /* ---------------- artifact_update ---------------- */

  artifact_update: {
    name: "artifact_update",
    description:
      "Append or replace content in an existing artifact. Use when you need to extend a long document in chunks or fix a section after receiving feedback. Pass `append: true` to add to the end, otherwise the full content replaces the existing body.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The artifact id returned by artifact_create." },
        content: { type: "string", description: "New content block." },
        append: {
          type: "boolean",
          description: "If true, append to existing content. If false or omitted, replace.",
        },
      },
      required: ["id", "content"],
      additionalProperties: false,
    },
    executionHandler: async (args, ctx) => {
      const id = String((args as any).id ?? "").trim();
      const content = String((args as any).content ?? "");
      const append = Boolean((args as any).append);
      const uid = typeof ctx.userId === "number" ? ctx.userId : null;
      if (!uid) return { ok: false, error: "USER_ID_MISSING" };
      if (!id || !content) return { ok: false, error: "ID_CONTENT_REQUIRED" };
      try {
        const { pgPool } = await import("../../db/postgres.js");
        if (append) {
          await pgPool.query(
            `UPDATE artifacts
               SET content = COALESCE(content,'') || $3,
                   size_bytes = OCTET_LENGTH(COALESCE(content,'') || $3),
                   completed_at = NOW()
               WHERE id = $1 AND user_id = $2`,
            [id, uid, content],
          );
        } else {
          await pgPool.query(
            `UPDATE artifacts
               SET content = $3,
                   size_bytes = OCTET_LENGTH($3),
                   completed_at = NOW()
               WHERE id = $1 AND user_id = $2`,
            [id, uid, content],
          );
        }
        return { ok: true, output: { id, append, bytes: Buffer.byteLength(content, "utf8") } };
      } catch (err: any) {
        console.warn("[tool:artifact_update] failed", err);
        return { ok: false, error: err?.message ?? "INTERNAL" };
      }
    },
  },

  /* ---------------- activate_skill ---------------- */

  activate_skill: {
    name: "activate_skill",
    description:
      "Acknowledge that you are following a specific enabled skill for this turn. Call this after you've decided which skill's 'when to use' section matches the user's request. This is a silent telemetry + state-recording call — the skill's markdown body is already injected into your system prompt, so the call's effect is to emit an observability signal, not to load new context. Call AT MOST TWO times per turn and never if no skill matches.",
    parameters: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description:
            "The slug of the skill you are following (e.g. 'code-review', 'memory', 'debugging'). Must be one of the skills listed in your <skills> block.",
        },
        reason: {
          type: "string",
          description:
            "One sentence explaining why this skill matches the user's request. Used for telemetry only.",
        },
      },
      required: ["slug"],
      additionalProperties: false,
    },
    executionHandler: async (args, ctx) => {
      const slug = String((args as any).slug ?? "").trim();
      const reason = String((args as any).reason ?? "").trim().slice(0, 240);
      if (!slug) return { ok: false, error: "SLUG_REQUIRED" };
      const uid = typeof ctx.userId === "number" ? ctx.userId : null;
      try {
        // Verify the skill exists in this user's installed set.
        const { listInstalledSkills } =
          await import("../../skills/skills-registry.js");
        const skills = uid ? await listInstalledSkills(uid) : [];
        const match = skills.find((s: any) => s.slug === slug && s.enabled);
        if (!match) {
          return { ok: false, error: "UNKNOWN_OR_DISABLED_SKILL", slug };
        }
        console.log("[tool:activate_skill]", {
          userId: uid,
          threadId: ctx.threadId,
          slug,
          name: match.name,
          reason,
        });
        return {
          ok: true,
          output: {
            slug,
            name: match.name,
            version: match.version,
            acknowledged: true,
          },
        };
      } catch (err: any) {
        console.warn("[tool:activate_skill] failed", err);
        return { ok: false, error: err?.message ?? "INTERNAL" };
      }
    },
  },
};

/* ===========================================================
   Responses API Tool Schema Builder (CORRECT FORMAT)
=========================================================== */

export function buildOpenAIToolSchemas(names: OpenAIToolName[]) {
  // ✅ Responses API(내부 태깅): { type:"function", name, description, parameters }
  // (Chat Completions는 { type:"function", function:{...} } 형태)
  return names.map((n) => ({
    type: "function",
    name: registry[n].name,
    description: registry[n].description,
    parameters: registry[n].parameters,
  }));
}

/* ===========================================================
   Execution
=========================================================== */

export function executeOpenAITool(
  name: OpenAIToolName,
  args: Record<string, unknown>,
  ctx: OpenAIToolHandlerContext
): Promise<OpenAIToolExecutionResult> {
  return registry[name].executionHandler(args, ctx);
}

/* ===========================================================
   ToolGate Mapping
=========================================================== */

export function mapAllowedToolTypesToOpenAITools(
  allowed: ToolType[],
  allowSearch: boolean
): OpenAIToolName[] {
  const names: OpenAIToolName[] = [];

  if (allowed.includes("OPENAI_WEB_SEARCH") && allowSearch) {
    names.push("web_search");
  }

  if (allowed.includes("OPENAI_WEB_FETCH") && allowSearch) {
    names.push("web_fetch");
  }

  if (allowed.includes("OPENAI_CODE_INTERPRETER")) {
    names.push("code_interpreter" as any);
  }

  if (allowed.includes("PY_SOLVER")) {
    names.push("extract_numbers");
  }

  // analyze_image / analyze_csv are auto-allowed via ToolGate signals,
  // not via allowedTools list. They are registered separately in ExecutionEngine.

  return Array.from(new Set(names));
}
