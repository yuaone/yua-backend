// src/routes/chat-upload.router.ts

import { Router } from "express";
import crypto from "crypto";
import multer from "multer";
import { requireAuthOrApiKey } from "../auth/auth-or-apikey";
import { withWorkspace } from "../middleware/with-workspace";
import { ChatUploadService } from "../ai/upload/chat-upload.service";
import { signAssetUrl } from "../utils/signed-url";
import { pgPool } from "../db/postgres";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
});

router.use(requireAuthOrApiKey("yua"));
router.use(withWorkspace);

/**
 * POST /api/chat/upload
 * multipart/form-data
 * field: file
 */
router.post("/upload", upload.single("file"), async (req: any, res) => {
  console.log("UPLOAD ENTRY");
  console.log("USER:", req.user);
  console.log("WORKSPACE:", req.workspace);
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ ok: false, error: "NO_FILE" });
    }

    const workspaceId = req.workspace?.id;
    const saved = await ChatUploadService.saveAttachment(file, {
      userId,
      workspaceId,
    });

    // Sign the asset URL with 24-hour TTL (relative path for Next.js rewrite)
    const signedPath = signAssetUrl(saved.url, 86_400);

    const kind =
      file.mimetype?.startsWith("image/")
        ? "image"
        : "file";

    // SSOT: DB write (chatController only)
    return res.json({
      ok: true,
      attachment: {
        id: crypto.randomUUID(),
        kind,
        fileName: saved.fileName,
        mimeType: saved.mimeType,
        sizeBytes: saved.sizeBytes,
        url: signedPath,
      },
    });
  } catch (e: any) {
    console.error("[CHAT_UPLOAD_ERROR]", e);
    return res.status(500).json({
      ok: false,
      error: e?.message ?? "UPLOAD_FAILED",
    });
  }
});

/**
 * Language detection from filename extension.
 * Returns Prism-compatible language ids.
 */
function detectLanguage(filename: string): string {
  const dotIdx = filename.lastIndexOf(".");
  if (dotIdx < 0 || dotIdx === filename.length - 1) return "plaintext";
  const ext = filename.slice(dotIdx + 1).toLowerCase();
  const map: Record<string, string> = {
    py: "python",
    pyw: "python",
    ipynb: "python",
    ts: "typescript",
    tsx: "typescript",
    mts: "typescript",
    cts: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    rs: "rust",
    go: "go",
    java: "java",
    kt: "kotlin",
    kts: "kotlin",
    swift: "swift",
    c: "c",
    h: "c",
    cpp: "cpp",
    cxx: "cpp",
    cc: "cpp",
    hpp: "cpp",
    cs: "csharp",
    rb: "ruby",
    php: "php",
    scala: "scala",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    json: "json",
    jsonc: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    xml: "xml",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    sass: "sass",
    sql: "sql",
    md: "markdown",
    mdx: "markdown",
    rst: "rst",
    v: "verilog",
    sv: "verilog",
    verilog: "verilog",
    pdf: "plaintext",
    txt: "plaintext",
    log: "plaintext",
    conf: "plaintext",
    ini: "ini",
    csv: "plaintext",
    tsv: "plaintext",
  };
  return map[ext] || "plaintext";
}

const CODE_LANGUAGES = new Set([
  "python",
  "typescript",
  "javascript",
  "rust",
  "go",
  "java",
  "kotlin",
  "swift",
  "c",
  "cpp",
  "csharp",
  "ruby",
  "php",
  "scala",
  "bash",
  "verilog",
]);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type SliceResult = {
  extractedText: string;
  startLine: number;
  endLine: number;
  sectionMatched: boolean;
};

function sliceBySection(
  text: string,
  section: string,
  language: string,
  filename: string
): SliceResult {
  const lines = text.split("\n");
  const total = lines.length;
  const trimmedSection = (section || "").trim();
  if (!trimmedSection) {
    return {
      extractedText: text,
      startLine: 1,
      endLine: total,
      sectionMatched: false,
    };
  }

  const ext = (filename.lastIndexOf(".") >= 0
    ? filename.slice(filename.lastIndexOf(".") + 1)
    : ""
  ).toLowerCase();

  // PDF: "page N" handling
  if (ext === "pdf") {
    const pageMatch = trimmedSection.match(/page\s*(\d+)/i);
    if (pageMatch) {
      const pageNum = Math.max(1, parseInt(pageMatch[1], 10));
      // Split on form-feed or triple-newline as page breaks
      const parts = text.includes("\f")
        ? text.split("\f")
        : text.split(/\n{3,}/);
      if (pageNum - 1 < parts.length) {
        const content = parts[pageNum - 1] ?? "";
        // Compute approximate line offset
        let startLine = 1;
        for (let i = 0; i < pageNum - 1; i++) {
          startLine += (parts[i]?.split("\n").length ?? 0);
        }
        const pageLineCount = content.split("\n").length;
        return {
          extractedText: content,
          startLine,
          endLine: startLine + pageLineCount - 1,
          sectionMatched: true,
        };
      }
    }
    // fall-through to literal search
  }

  // Text files: line-number shortcut (L42, 42)
  if (language === "plaintext" || ext === "txt" || ext === "log" || ext === "conf") {
    const lineMatch = trimmedSection.match(/^L?(\d+)$/i);
    if (lineMatch) {
      const target = Math.max(1, parseInt(lineMatch[1], 10));
      const start = Math.max(1, target - 20);
      const end = Math.min(total, target + 20);
      return {
        extractedText: lines.slice(start - 1, end).join("\n"),
        startLine: start,
        endLine: end,
        sectionMatched: target <= total,
      };
    }
  }

  // Markdown: header-based slicing
  if (language === "markdown" || ext === "md" || ext === "mdx" || ext === "rst") {
    const escSection = escapeRegex(trimmedSection);
    const headerRe = new RegExp(`^(#+)\\s+${escSection}\\s*$`, "i");
    let headerIdx = -1;
    let headerLevel = 0;
    for (let i = 0; i < total; i++) {
      const m = lines[i].match(headerRe);
      if (m) {
        headerIdx = i;
        headerLevel = m[1].length;
        break;
      }
    }
    if (headerIdx >= 0) {
      // Find the next header at same-or-higher level
      let endIdx = total - 1;
      for (let i = headerIdx + 1; i < total; i++) {
        const m = lines[i].match(/^(#+)\s+/);
        if (m && m[1].length <= headerLevel) {
          endIdx = i - 1;
          break;
        }
      }
      return {
        extractedText: lines.slice(headerIdx, endIdx + 1).join("\n"),
        startLine: headerIdx + 1,
        endLine: endIdx + 1,
        sectionMatched: true,
      };
    }
    // fall-through
  }

  // Data files (json/yaml/toml/xml): key search
  if (["json", "yaml", "toml", "xml"].includes(language)) {
    const escSection = escapeRegex(trimmedSection);
    // "key": or key: or <key>
    const keyRe = new RegExp(
      `("${escSection}"\\s*:|\\b${escSection}\\s*:|<${escSection}[\\s>])`
    );
    for (let i = 0; i < total; i++) {
      if (keyRe.test(lines[i])) {
        const start = Math.max(1, i + 1 - 10);
        const end = Math.min(total, i + 1 + 10);
        return {
          extractedText: lines.slice(start - 1, end).join("\n"),
          startLine: start,
          endLine: end,
          sectionMatched: true,
        };
      }
    }
    // fall-through
  }

  // Code files: class/def/function/interface/struct block detection
  if (CODE_LANGUAGES.has(language)) {
    // Try to detect keyword prefix in section label
    const blockKwMatch = trimmedSection.match(
      /^(class|def|function|interface|struct|fn|func|impl)\s+(.+)$/
    );
    if (blockKwMatch) {
      const ident = blockKwMatch[2].split(/[\s(<:{]/)[0];
      const escIdent = escapeRegex(ident);
      // Look for a line containing the block-def keyword + ident
      const blockRe = new RegExp(
        `\\b(class|def|function|interface|struct|fn|func|impl)\\b[^\\n]*\\b${escIdent}\\b`
      );
      for (let i = 0; i < total; i++) {
        if (blockRe.test(lines[i])) {
          const indent = (lines[i].match(/^\s*/)?.[0] ?? "").length;
          let endIdx = i;
          for (let j = i + 1; j < total; j++) {
            const l = lines[j];
            if (l.trim() === "") {
              endIdx = j;
              continue;
            }
            const curIndent = (l.match(/^\s*/)?.[0] ?? "").length;
            if (curIndent > indent) {
              endIdx = j;
            } else {
              break;
            }
          }
          const end = Math.min(total, endIdx + 3 + 1); // +3 trailing context
          return {
            extractedText: lines.slice(i, end).join("\n"),
            startLine: i + 1,
            endLine: end,
            sectionMatched: true,
          };
        }
      }
    }

    // Plain identifier search (word-bounded)
    const ident2 = trimmedSection.split(/[\s(<:{]/)[0];
    if (ident2) {
      const escIdent2 = escapeRegex(ident2);
      const re = new RegExp(`\\b${escIdent2}\\b`);
      for (let i = 0; i < total; i++) {
        if (re.test(lines[i])) {
          const start = Math.max(1, i + 1 - 15);
          const end = Math.min(total, i + 1 + 15);
          return {
            extractedText: lines.slice(start - 1, end).join("\n"),
            startLine: start,
            endLine: end,
            sectionMatched: true,
          };
        }
      }
    }
    // fall-through
  }

  // XLSX/XLS: "[Sheet: name]" blocks with CSV rows
  if (ext === "xlsx" || ext === "xls") {
    // Try "<sheet> row N" pattern
    const rowMatch = trimmedSection.match(/^(.+?)\s+row\s*(\d+)$/i);
    if (rowMatch) {
      const sheetHint = rowMatch[1].trim();
      const rowNum = Math.max(1, parseInt(rowMatch[2], 10));
      const escSheet = escapeRegex(sheetHint);
      const headerRe = new RegExp(`^\\[Sheet:\\s*${escSheet}\\s*\\]`, "i");
      let blockStart = -1;
      for (let i = 0; i < total; i++) {
        if (headerRe.test(lines[i])) {
          blockStart = i;
          break;
        }
      }
      if (blockStart >= 0) {
        // Block ends at next [Sheet: ...] or EOF
        let blockEnd = total - 1;
        for (let i = blockStart + 1; i < total; i++) {
          if (/^\[Sheet:\s*/i.test(lines[i])) {
            blockEnd = i - 1;
            break;
          }
        }
        // Row index is 1-based relative to data rows (after header line)
        const dataStart = blockStart + 1;
        const targetLine = dataStart + rowNum - 1;
        if (targetLine <= blockEnd) {
          const start = Math.max(blockStart + 1, targetLine + 1 - 10);
          const end = Math.min(blockEnd + 1, targetLine + 1 + 10);
          return {
            extractedText: lines.slice(start - 1, end).join("\n"),
            startLine: start,
            endLine: end,
            sectionMatched: true,
          };
        }
        // Row out of range — return whole block
        return {
          extractedText: lines.slice(blockStart, blockEnd + 1).join("\n"),
          startLine: blockStart + 1,
          endLine: blockEnd + 1,
          sectionMatched: true,
        };
      }
    }
    // "Sheet: name" or plain sheet name → return whole sheet block
    const sheetOnly = trimmedSection.replace(/^Sheet:\s*/i, "").trim();
    if (sheetOnly) {
      const escSheet = escapeRegex(sheetOnly);
      const headerRe = new RegExp(`^\\[Sheet:\\s*${escSheet}\\s*\\]`, "i");
      for (let i = 0; i < total; i++) {
        if (headerRe.test(lines[i])) {
          let blockEnd = total - 1;
          for (let j = i + 1; j < total; j++) {
            if (/^\[Sheet:\s*/i.test(lines[j])) {
              blockEnd = j - 1;
              break;
            }
          }
          return {
            extractedText: lines.slice(i, blockEnd + 1).join("\n"),
            startLine: i + 1,
            endLine: blockEnd + 1,
            sectionMatched: true,
          };
        }
      }
    }
    // fall-through to generic search
  }

  // PPTX: "slide N" → find "[Slide N]" block
  if (ext === "pptx") {
    const slideMatch = trimmedSection.match(/slide\s*(\d+)/i);
    if (slideMatch) {
      const slideNum = Math.max(1, parseInt(slideMatch[1], 10));
      const headerRe = new RegExp(`^\\[Slide\\s+${slideNum}\\]\\s*$`);
      for (let i = 0; i < total; i++) {
        if (headerRe.test(lines[i])) {
          let blockEnd = total - 1;
          for (let j = i + 1; j < total; j++) {
            if (/^\[Slide\s+\d+\]\s*$/.test(lines[j])) {
              blockEnd = j - 1;
              break;
            }
          }
          return {
            extractedText: lines.slice(i, blockEnd + 1).join("\n"),
            startLine: i + 1,
            endLine: blockEnd + 1,
            sectionMatched: true,
          };
        }
      }
    }
    // fall-through
  }

  // DOCX: "section N" or heading text → text search with ±15 line window
  if (ext === "docx") {
    const sectionMatch = trimmedSection.match(/^section\s+(.+)$/i);
    const needle = sectionMatch ? sectionMatch[1].trim() : trimmedSection;
    if (needle) {
      const lowerNeedle = needle.toLowerCase();
      for (let i = 0; i < total; i++) {
        if (lines[i].toLowerCase().indexOf(lowerNeedle) !== -1) {
          const start = Math.max(1, i + 1 - 15);
          const end = Math.min(total, i + 1 + 15);
          return {
            extractedText: lines.slice(start - 1, end).join("\n"),
            startLine: start,
            endLine: end,
            sectionMatched: true,
          };
        }
      }
    }
    // fall-through
  }

  // Generic literal search (any file kind)
  {
    const needle = trimmedSection;
    for (let i = 0; i < total; i++) {
      if (lines[i].indexOf(needle) !== -1) {
        const start = Math.max(1, i + 1 - 15);
        const end = Math.min(total, i + 1 + 15);
        return {
          extractedText: lines.slice(start - 1, end).join("\n"),
          startLine: start,
          endLine: end,
          sectionMatched: true,
        };
      }
    }
  }

  // No match — return top of file
  const fallback = text.slice(0, 3000);
  const fallbackLineCount = fallback.split("\n").length;
  return {
    extractedText: fallback,
    startLine: 1,
    endLine: fallbackLineCount,
    sectionMatched: false,
  };
}

/**
 * GET /api/chat/upload/extract?name=<filename>&section=<section>
 * Returns cached extracted_text for a file uploaded in the current workspace.
 * When `section` is provided, returns a targeted slice (8KB cap).
 * When `section` is absent, returns full text (50KB cap, backward compatible).
 */
router.get("/upload/extract", async (req: any, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    }

    const rawName = req.query?.name;
    const fileName = typeof rawName === "string" ? rawName.trim() : "";
    if (!fileName || fileName.length > 512) {
      return res.status(400).json({ ok: false, error: "INVALID_NAME" });
    }
    const rawSection = req.query?.section;
    const sectionRaw =
      typeof rawSection === "string" ? rawSection.trim() : "";
    // Sanity cap on section label to avoid pathological regex construction.
    const section = sectionRaw.length > 256 ? sectionRaw.slice(0, 256) : sectionRaw;

    const workspaceId = req.workspace?.id;
    if (!workspaceId) {
      return res.status(400).json({ ok: false, error: "NO_WORKSPACE" });
    }

    // file_documents has no user_id column — scope via file_sessions.workspace_id.
    // Pick most recently created matching document.
    const q = `
      SELECT d.file_name, d.extracted_text
      FROM file_documents d
      INNER JOIN file_sessions s ON s.id = d.session_id
      WHERE s.workspace_id = $1 AND d.file_name = $2
      ORDER BY d.created_at DESC
      LIMIT 1
    `;
    const r = await pgPool.query<{ file_name: string; extracted_text: string | null }>(
      q,
      [String(workspaceId), fileName]
    );

    if (!r.rows.length) {
      return res.json({ ok: false, error: "NOT_FOUND" });
    }

    const row = r.rows[0];
    const text = typeof row.extracted_text === "string" ? row.extracted_text : "";
    const language = detectLanguage(row.file_name || fileName);
    const totalLines = text.length === 0 ? 0 : text.split("\n").length;

    // If section is provided → targeted slice (8KB cap)
    if (section) {
      const slice = sliceBySection(text, section, language, row.file_name || fileName);
      const SLICE_LIMIT = 8 * 1024;
      const sliced =
        slice.extractedText.length > SLICE_LIMIT
          ? slice.extractedText.slice(0, SLICE_LIMIT)
          : slice.extractedText;
      return res.json({
        ok: true,
        fileName: row.file_name,
        section,
        extractedText: sliced,
        language,
        startLine: slice.startLine,
        endLine: slice.endLine,
        totalLines,
        sectionMatched: slice.sectionMatched,
        truncated: slice.extractedText.length > SLICE_LIMIT,
      });
    }

    // No section → full text (50KB cap, backward-compatible)
    const LIMIT = 50 * 1024;
    const extractedText = text.length > LIMIT ? text.slice(0, LIMIT) : text;
    return res.json({
      ok: true,
      fileName: row.file_name,
      section: null,
      extractedText,
      language,
      startLine: 1,
      endLine: extractedText.split("\n").length,
      totalLines,
      sectionMatched: false,
      truncated: text.length > LIMIT,
    });
  } catch (e: any) {
    console.error("[CHAT_UPLOAD_EXTRACT_ERROR]", e);
    return res.status(500).json({
      ok: false,
      error: e?.message ?? "EXTRACT_FAILED",
    });
  }
});

export default router;
