// src/agent/agent-executor.ts
// YUAN Coding Agent — Agent Executor (Tool-Use Loop Orchestrator)
//
// Bridges yua-backend with the YUAN coding agent loop.
// Manages: LLM calls -> tool_use parsing -> tool execution -> result injection -> repeat.

import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { pgPool } from "../db/postgres";
import { AgentSessionManager } from "./agent-session-manager";
import { detectSecrets } from "./security/secret-detector";
import { AuditLogger } from "./security/audit-logger";

const execFileAsync = promisify(execFile);

/* ==================================================================
 * Types
 * ================================================================== */

/** Interrupt signals the executor listens for */
export type InterruptSignal = "soft" | "hard" | "pause" | "resume";

/** Plan-based limits passed from the router */
export interface PlanLimits {
  maxIterations: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

/** Config for constructing an AgentExecutor */
export interface AgentExecutorConfig {
  sessionId: string;
  prompt: string;
  model: string;
  provider: string;
  workDir: string;
  planLimits: PlanLimits;
  /** User's own API key (BYOK). If omitted, platform key is used. */
  apiKey?: string;
  /** Maximum tokens per LLM response */
  maxTokensPerResponse?: number;
}

/** Internal message format matching Anthropic SDK */
type Message = Anthropic.MessageParam;
type ContentBlock = Anthropic.ContentBlock;
type ToolUseBlock = Anthropic.ToolUseBlock;
type ToolResultBlockParam = Anthropic.ToolResultBlockParam;

/** Tool definition in Claude's tool_use format */
interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Result of executing a single tool */
interface ToolExecResult {
  output: string;
  isError: boolean;
}

/* ==================================================================
 * Constants
 * ================================================================== */

const MAX_LLM_RETRIES = 3;
const MAX_TOOL_OUTPUT_LENGTH = 100_000;
const DEFAULT_MAX_TOKENS = 8192;
const SHELL_TIMEOUT_MS = 60_000;
const SHELL_MAX_OUTPUT = 200_000;

/** Commands that are never allowed in shell_exec */
const BLOCKED_COMMANDS = new Set([
  "rm", "rmdir", "mkfs", "dd", "shutdown", "reboot", "halt", "poweroff",
  "init", "kill", "killall", "pkill", "format", "fdisk", "mount", "umount",
  "chown", "chmod", "passwd", "useradd", "userdel", "groupadd", "groupdel",
  "iptables", "systemctl", "service",
]);

/** File patterns that require approval before write/edit */
const SENSITIVE_FILE_PATTERNS = [
  /\.env/i,
  /credentials/i,
  /secret/i,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa/i,
  /\.ssh\//i,
  /password/i,
  /token/i,
];

/* ==================================================================
 * Tool Definitions (Claude tool_use format)
 * ================================================================== */

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "file_read",
    description:
      "Read the contents of a file. Returns the file content with line numbers. " +
      "Use offset/limit for large files.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file" },
        offset: { type: "number", description: "Line number to start from (1-based). Optional." },
        limit: { type: "number", description: "Max lines to read. Optional, default 2000." },
      },
      required: ["path"],
    },
  },
  {
    name: "file_write",
    description:
      "Write content to a file, creating it if it doesn't exist. Overwrites existing content.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file" },
        content: { type: "string", description: "The full content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "file_edit",
    description:
      "Replace an exact string in a file with a new string. " +
      "The old_string must match exactly (including whitespace). " +
      "Use replace_all to replace every occurrence.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file" },
        old_string: { type: "string", description: "Exact text to find and replace" },
        new_string: { type: "string", description: "Replacement text" },
        replace_all: {
          type: "boolean",
          description: "Replace all occurrences (default false)",
          default: false,
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "shell_exec",
    description:
      "Execute a shell command in the project working directory. " +
      "Use for builds, tests, git commands, etc. Timeout: 60s.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute" },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (max 120000). Default: 60000.",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "grep",
    description:
      "Search for a regex pattern in files. Returns matching lines with file paths and line numbers.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "Directory or file to search in. Default: workDir." },
        glob: { type: "string", description: 'File glob filter, e.g. "*.ts"' },
        max_results: { type: "number", description: "Max results to return. Default: 50." },
        case_insensitive: { type: "boolean", description: "Case-insensitive search. Default: false." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "glob",
    description: "Find files matching a glob pattern. Returns file paths sorted by modification time.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: 'Glob pattern, e.g. "**/*.ts" or "src/**/*.tsx"' },
        path: { type: "string", description: "Base directory. Default: workDir." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "git_ops",
    description:
      "Run a git operation. Supports: status, diff, log, add, commit, branch, checkout. " +
      "Destructive operations (push --force, reset --hard) are blocked.",
    input_schema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description: "Git subcommand: status, diff, log, add, commit, branch, checkout, show",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Arguments for the git subcommand",
        },
      },
      required: ["operation"],
    },
  },
  {
    name: "code_search",
    description:
      "Semantic search for code symbols (functions, classes, types) using ripgrep patterns. " +
      "Returns matching definitions with context.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Symbol name or pattern to search for (e.g. function name, class name)",
        },
        file_type: {
          type: "string",
          description: 'File type filter: "ts", "tsx", "js", "py", "go", "rs", etc.',
        },
        path: { type: "string", description: "Directory to search in. Default: workDir." },
      },
      required: ["query"],
    },
  },
  {
    name: "test_run",
    description:
      "Run the project's test suite or a specific test file. Detects test runner automatically.",
    input_schema: {
      type: "object",
      properties: {
        test_file: { type: "string", description: "Specific test file to run. Optional." },
        test_name: { type: "string", description: "Specific test name/pattern to run. Optional." },
        runner: {
          type: "string",
          description: 'Test runner override: "jest", "vitest", "mocha", "pytest". Auto-detected if omitted.',
        },
      },
      required: [],
    },
  },
];

/* ==================================================================
 * System Prompt Builder
 * ================================================================== */

/**
 * Build the system prompt with workDir context, tool list, and coding guidelines.
 * Includes YUAN.md from the project root if it exists.
 */
async function buildSystemPrompt(workDir: string): Promise<string> {
  const toolNames = TOOL_DEFINITIONS.map((t) => t.name).join(", ");

  let yuanMdContent = "";
  try {
    const yuanMdPath = path.join(workDir, "YUAN.md");
    yuanMdContent = await fs.readFile(yuanMdPath, "utf-8");
  } catch {
    // YUAN.md not found — that's fine
  }

  let claudeMdContent = "";
  try {
    const claudeMdPath = path.join(workDir, "CLAUDE.md");
    claudeMdContent = await fs.readFile(claudeMdPath, "utf-8");
  } catch {
    // CLAUDE.md not found — that's fine
  }

  const projectContext = yuanMdContent || claudeMdContent
    ? `\n\n<project-instructions>\n${yuanMdContent || claudeMdContent}\n</project-instructions>`
    : "";

  return [
    "You are YUAN, an expert coding agent. You help users with software engineering tasks",
    "by reading, writing, and editing code in their project.",
    "",
    `Working directory: ${workDir}`,
    `Available tools: ${toolNames}`,
    "",
    "## Guidelines",
    "- Read files before editing them to understand context.",
    "- Make minimal, focused changes. Do not rewrite entire files unless necessary.",
    "- Prefer editing existing files over creating new ones.",
    "- Run builds/tests after making changes to verify correctness.",
    "- Use git_ops to check status before and after changes.",
    "- Never commit unless the user asks you to.",
    "- Never expose secrets, API keys, or credentials in file content.",
    "- Explain your reasoning briefly before taking action.",
    "- If you encounter errors, diagnose the root cause before retrying.",
    "",
    "## File Path Rules",
    `- All file paths must be absolute and within: ${workDir}`,
    "- Never access files outside the working directory.",
    "",
    "## Safety",
    "- Destructive shell commands (rm -rf, format, etc.) are blocked.",
    "- Writing to .env or credential files requires user approval.",
    "- Force-push and hard reset are blocked in git_ops.",
    projectContext,
  ].join("\n");
}

/* ==================================================================
 * AgentExecutor
 * ================================================================== */

/**
 * Orchestrates a single YUAN agent session.
 *
 * Manages the tool-use loop:
 *   system prompt + history -> LLM call -> parse tool_use blocks ->
 *   execute tools -> add results -> repeat until done or limit reached.
 *
 * Emits real-time events via AgentSessionManager for SSE streaming.
 * Persists iterations to PostgreSQL agent_iterations table.
 */
export class AgentExecutor {
  private readonly sessionId: string;
  private readonly runId: string;
  private readonly prompt: string;
  private readonly model: string;
  private readonly workDir: string;
  private readonly planLimits: PlanLimits;
  private readonly client: Anthropic;
  private readonly maxTokensPerResponse: number;

  private messages: Message[] = [];
  private iteration = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private interrupted: InterruptSignal | null = null;
  private paused = false;
  private pauseResolve: (() => void) | null = null;
  private alwaysApprovedTools = new Set<string>();

  constructor(config: AgentExecutorConfig) {
    this.sessionId = config.sessionId;
    this.prompt = config.prompt;
    this.model = config.model;
    this.workDir = config.workDir;
    this.planLimits = config.planLimits;
    this.maxTokensPerResponse = config.maxTokensPerResponse ?? DEFAULT_MAX_TOKENS;

    // Resolve run ID from session manager
    const session = AgentSessionManager.getSession(config.sessionId);
    this.runId = session?.runId ?? randomUUID();

    // BYOK: use user's API key if provided, else platform key
    const apiKey = config.apiKey || process.env.CLAUDE_API_KEY || "";
    this.client = new Anthropic({ apiKey });

    // Listen for interrupt signals
    if (session) {
      session.emitter.on("stop", () => {
        this.interrupted = "hard";
      });
      session.emitter.on("approval_response", (data: { actionId: string; response: string }) => {
        if (data.response === "reject") {
          // Rejection handled inline in approval flow
        }
        // Resume is handled by the pause mechanism
      });
    }
  }

  /* ------------------------------------------------------------------
   * Public API
   * ------------------------------------------------------------------ */

  /**
   * Run the agent loop to completion.
   * This is the main entry point — call once after construction.
   */
  async run(): Promise<void> {
    try {
      AgentSessionManager.updateStatus(this.sessionId, "running");

      // Audit: session start
      const session = AgentSessionManager.getSession(this.sessionId);
      AuditLogger.logSessionStart(this.sessionId, session?.userId ?? 0, this.prompt, this.model);

      // Build system prompt
      const systemPrompt = await buildSystemPrompt(this.workDir);

      // Seed conversation with user prompt
      this.messages = [{ role: "user", content: this.prompt }];

      // Main loop
      while (!this.shouldTerminate()) {
        // Check pause state
        if (this.paused) {
          await this.waitForResume();
        }

        this.iteration++;
        const iterationId = randomUUID();

        this.emitEvent("agent:iteration_start", {
          iteration: this.iteration,
          maxIterations: this.planLimits.maxIterations,
        });

        // Call LLM with retries
        const response = await this.callLLMWithRetry(systemPrompt);
        if (!response) {
          // All retries exhausted
          this.emitEvent("agent:error", { message: "LLM call failed after retries" });
          AgentSessionManager.updateStatus(this.sessionId, "failed", "LLM call failed after retries");
          return;
        }

        // Track token usage
        this.totalInputTokens += response.usage.input_tokens;
        this.totalOutputTokens += response.usage.output_tokens;
        this.updateSessionTokens();

        // Process response content blocks
        const toolUseBlocks: ToolUseBlock[] = [];
        const assistantContent: ContentBlock[] = response.content;

        for (const block of assistantContent) {
          if (block.type === "text") {
            this.emitEvent("agent:text_delta", { text: block.text });
          } else if (block.type === "tool_use") {
            toolUseBlocks.push(block);
          }
        }

        // Add assistant message to history
        this.messages.push({ role: "assistant", content: assistantContent });

        // Persist iteration
        await this.persistIteration(iterationId, assistantContent, toolUseBlocks);

        // If no tool calls, the agent is done (end_turn)
        if (response.stop_reason === "end_turn" || toolUseBlocks.length === 0) {
          this.emitEvent("agent:iteration_end", {
            iteration: this.iteration,
            stopReason: response.stop_reason,
          });
          break;
        }

        // Execute tools and collect results
        const toolResults: ToolResultBlockParam[] = [];

        for (const toolUse of toolUseBlocks) {
          if (this.interrupted === "hard") break;

          this.emitEvent("agent:tool_call", {
            toolName: toolUse.name,
            toolInput: toolUse.input,
            toolUseId: toolUse.id,
          });

          // Audit: tool call
          AuditLogger.logToolCall(
            this.sessionId,
            AgentSessionManager.getSession(this.sessionId)?.userId ?? 0,
            toolUse.name,
            toolUse.input as Record<string, unknown>,
          );

          // Check if approval is needed
          const needsApproval = this.requiresApproval(toolUse.name, toolUse.input as Record<string, unknown>);
          if (needsApproval && !this.alwaysApprovedTools.has(toolUse.name)) {
            const approved = await this.requestApproval(toolUse);
            if (approved === "reject") {
              toolResults.push({
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: "Tool execution was rejected by the user.",
                is_error: true,
              });
              this.emitEvent("agent:tool_result", {
                toolUseId: toolUse.id,
                toolName: toolUse.name,
                output: "Rejected by user",
                isError: true,
              });
              continue;
            }
            if (approved === "always_approve") {
              this.alwaysApprovedTools.add(toolUse.name);
            }
          }

          // Execute the tool
          const result = await this.executeTool(toolUse.name, toolUse.input as Record<string, unknown>);

          let truncatedOutput =
            result.output.length > MAX_TOOL_OUTPUT_LENGTH
              ? result.output.slice(0, MAX_TOOL_OUTPUT_LENGTH) + "\n... [truncated]"
              : result.output;

          // Secret detection — redact before SSE/DB
          const secretResult = detectSecrets(truncatedOutput);
          if (secretResult.hasSecrets) {
            truncatedOutput = secretResult.redacted;
            AuditLogger.logSecretDetected(
              this.sessionId,
              AgentSessionManager.getSession(this.sessionId)?.userId ?? 0,
              toolUse.name,
              secretResult.matches.map((m) => m.label),
            );
            this.emitEvent("agent:error", {
              message: `Secret detected in ${toolUse.name} output (${secretResult.matches.length} match${secretResult.matches.length > 1 ? "es" : ""}). Output redacted.`,
            });
          }

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: truncatedOutput,
            is_error: result.isError,
          });

          // Audit: tool result
          AuditLogger.logToolResult(
            this.sessionId,
            AgentSessionManager.getSession(this.sessionId)?.userId ?? 0,
            toolUse.name,
            truncatedOutput,
            result.isError,
          );

          this.emitEvent("agent:tool_result", {
            toolUseId: toolUse.id,
            toolName: toolUse.name,
            output: truncatedOutput.slice(0, 2000), // SSE payload limit
            isError: result.isError,
          });
        }

        // Add tool results to conversation
        if (toolResults.length > 0) {
          this.messages.push({ role: "user", content: toolResults });
        }

        this.emitEvent("agent:iteration_end", {
          iteration: this.iteration,
          stopReason: response.stop_reason,
          toolCalls: toolUseBlocks.length,
        });

        // Update session iteration count
        const session = AgentSessionManager.getSession(this.sessionId);
        if (session) {
          session.iterations = this.iteration;
          session.updatedAt = Date.now();
        }
      }

      // Determine final status
      if (this.interrupted) {
        AgentSessionManager.updateStatus(this.sessionId, "stopped");
      } else {
        AgentSessionManager.updateStatus(this.sessionId, "completed");
      }

      this.emitEvent("agent:done", {
        iterations: this.iteration,
        tokenUsage: { input: this.totalInputTokens, output: this.totalOutputTokens },
        reason: this.interrupted ? "interrupted" : "completed",
      });

      // Audit: session end
      AuditLogger.logSessionEnd(
        this.sessionId,
        AgentSessionManager.getSession(this.sessionId)?.userId ?? 0,
        this.interrupted ? "stopped" : "completed",
        this.iteration,
      );

      // Save final checkpoint
      await this.saveCheckpoint("completed");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[YUAN_AGENT] Executor error:", message);

      this.emitEvent("agent:error", { message });
      AgentSessionManager.updateStatus(this.sessionId, "failed", message);

      // Save crash checkpoint for recovery
      await this.saveCheckpoint("crashed");
    }
  }

  /**
   * Send an interrupt signal to the running executor.
   */
  interrupt(signal: InterruptSignal): void {
    if (signal === "pause") {
      this.paused = true;
      AgentSessionManager.updateStatus(this.sessionId, "paused");
    } else if (signal === "resume") {
      this.paused = false;
      this.pauseResolve?.();
      AgentSessionManager.updateStatus(this.sessionId, "running");
    } else {
      this.interrupted = signal;
    }
  }

  /* ------------------------------------------------------------------
   * LLM Call
   * ------------------------------------------------------------------ */

  /**
   * Call the LLM with automatic retry on transient errors.
   * Returns null if all retries are exhausted.
   */
  private async callLLMWithRetry(
    systemPrompt: string
  ): Promise<Anthropic.Message | null> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_LLM_RETRIES; attempt++) {
      try {
        this.emitEvent("agent:thinking", {
          message: attempt > 1 ? `Retrying LLM call (attempt ${attempt})...` : "Thinking...",
        });

        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: this.maxTokensPerResponse,
          system: systemPrompt,
          tools: TOOL_DEFINITIONS as Anthropic.Tool[],
          messages: this.messages,
        });

        return response;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const isTransient = this.isTransientError(lastError);

        console.error(
          `[YUAN_AGENT] LLM call attempt ${attempt}/${MAX_LLM_RETRIES} failed:`,
          lastError.message,
          isTransient ? "(transient, will retry)" : "(non-transient)"
        );

        if (!isTransient || attempt === MAX_LLM_RETRIES) {
          break;
        }

        // Exponential backoff: 1s, 2s, 4s
        await this.sleep(1000 * Math.pow(2, attempt - 1));
      }
    }

    console.error("[YUAN_AGENT] All LLM retries exhausted:", lastError?.message);
    return null;
  }

  /**
   * Check if an error is transient (rate limit, server error, network).
   */
  private isTransientError(err: Error): boolean {
    const msg = err.message.toLowerCase();
    return (
      msg.includes("rate_limit") ||
      msg.includes("overloaded") ||
      msg.includes("529") ||
      msg.includes("500") ||
      msg.includes("502") ||
      msg.includes("503") ||
      msg.includes("timeout") ||
      msg.includes("econnreset") ||
      msg.includes("econnrefused") ||
      msg.includes("socket hang up")
    );
  }

  /* ------------------------------------------------------------------
   * Tool Execution
   * ------------------------------------------------------------------ */

  /**
   * Execute a tool by name with the given input.
   * All file operations are sandboxed to workDir.
   */
  private async executeTool(
    name: string,
    input: Record<string, unknown>
  ): Promise<ToolExecResult> {
    try {
      switch (name) {
        case "file_read":
          return await this.toolFileRead(input);
        case "file_write":
          return await this.toolFileWrite(input);
        case "file_edit":
          return await this.toolFileEdit(input);
        case "shell_exec":
          return await this.toolShellExec(input);
        case "grep":
          return await this.toolGrep(input);
        case "glob":
          return await this.toolGlob(input);
        case "git_ops":
          return await this.toolGitOps(input);
        case "code_search":
          return await this.toolCodeSearch(input);
        case "test_run":
          return await this.toolTestRun(input);
        default:
          return { output: `Unknown tool: ${name}`, isError: true };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Tool execution error: ${message}`, isError: true };
    }
  }

  /* ---------- file_read ---------- */

  private async toolFileRead(input: Record<string, unknown>): Promise<ToolExecResult> {
    const filePath = this.resolveAndValidatePath(input.path as string);
    const offset = typeof input.offset === "number" ? input.offset : 1;
    const limit = typeof input.limit === "number" ? input.limit : 2000;

    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split("\n");
    const startIdx = Math.max(0, offset - 1);
    const slice = lines.slice(startIdx, startIdx + limit);

    const numbered = slice
      .map((line, i) => `${String(startIdx + i + 1).padStart(6)}  ${line}`)
      .join("\n");

    return { output: numbered, isError: false };
  }

  /* ---------- file_write ---------- */

  private async toolFileWrite(input: Record<string, unknown>): Promise<ToolExecResult> {
    const filePath = this.resolveAndValidatePath(input.path as string);
    const content = input.content as string;

    // Ensure parent directory exists
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");

    return { output: `File written: ${filePath} (${content.length} bytes)`, isError: false };
  }

  /* ---------- file_edit ---------- */

  private async toolFileEdit(input: Record<string, unknown>): Promise<ToolExecResult> {
    const filePath = this.resolveAndValidatePath(input.path as string);
    const oldString = input.old_string as string;
    const newString = input.new_string as string;
    const replaceAll = input.replace_all === true;

    const content = await fs.readFile(filePath, "utf-8");

    if (!content.includes(oldString)) {
      return {
        output: `Error: old_string not found in ${filePath}. Make sure the string matches exactly including whitespace.`,
        isError: true,
      };
    }

    if (!replaceAll) {
      // Check uniqueness
      const firstIdx = content.indexOf(oldString);
      const secondIdx = content.indexOf(oldString, firstIdx + 1);
      if (secondIdx !== -1) {
        return {
          output: `Error: old_string appears multiple times in ${filePath}. Use replace_all=true or provide more context to make the match unique.`,
          isError: true,
        };
      }
    }

    const updated = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);

    await fs.writeFile(filePath, updated, "utf-8");
    const count = replaceAll
      ? content.split(oldString).length - 1
      : 1;

    return {
      output: `File edited: ${filePath} (${count} replacement${count > 1 ? "s" : ""})`,
      isError: false,
    };
  }

  /* ---------- shell_exec ---------- */

  private async toolShellExec(input: Record<string, unknown>): Promise<ToolExecResult> {
    const command = input.command as string;
    const timeout = Math.min(
      typeof input.timeout === "number" ? input.timeout : SHELL_TIMEOUT_MS,
      120_000
    );

    // Security: validate command
    const firstWord = command.trim().split(/\s+/)[0]?.replace(/^.*\//, "");
    if (firstWord && BLOCKED_COMMANDS.has(firstWord)) {
      return {
        output: `Blocked: "${firstWord}" is not allowed for security reasons.`,
        isError: true,
      };
    }

    // Block dangerous patterns
    if (/rm\s+(-rf?|--recursive)\s+[\/~]/.test(command)) {
      return { output: "Blocked: destructive rm command targeting root or home.", isError: true };
    }
    if (/>\s*\/dev\/sd|mkfs|dd\s+if=/.test(command)) {
      return { output: "Blocked: potentially destructive disk operation.", isError: true };
    }

    try {
      const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
        cwd: this.workDir,
        timeout,
        maxBuffer: SHELL_MAX_OUTPUT,
        env: { ...process.env, HOME: this.workDir },
      });

      const combined = [stdout, stderr].filter(Boolean).join("\n");
      return { output: combined || "(no output)", isError: false };
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean; message?: string };
      if (execErr.killed) {
        return { output: `Command timed out after ${timeout}ms`, isError: true };
      }
      const out = [execErr.stdout, execErr.stderr].filter(Boolean).join("\n");
      return {
        output: out || `Command failed: ${execErr.message ?? "unknown error"}`,
        isError: true,
      };
    }
  }

  /* ---------- grep ---------- */

  private async toolGrep(input: Record<string, unknown>): Promise<ToolExecResult> {
    const pattern = input.pattern as string;
    const searchPath = input.path
      ? this.resolveAndValidatePath(input.path as string)
      : this.workDir;
    const maxResults = typeof input.max_results === "number" ? input.max_results : 50;
    const caseInsensitive = input.case_insensitive === true;

    const args = ["--no-heading", "--line-number", "--color=never", "-m", String(maxResults)];
    if (caseInsensitive) args.push("-i");
    if (typeof input.glob === "string") args.push("--glob", input.glob as string);
    args.push(pattern, searchPath);

    try {
      const { stdout } = await execFileAsync("rg", args, {
        cwd: this.workDir,
        timeout: 30_000,
        maxBuffer: SHELL_MAX_OUTPUT,
      });
      return { output: stdout || "No matches found.", isError: false };
    } catch (err: unknown) {
      const execErr = err as { code?: number; stdout?: string; message?: string };
      // rg returns exit code 1 for no matches
      if (execErr.code === 1) {
        return { output: "No matches found.", isError: false };
      }
      return { output: `grep error: ${execErr.message ?? "unknown"}`, isError: true };
    }
  }

  /* ---------- glob ---------- */

  private async toolGlob(input: Record<string, unknown>): Promise<ToolExecResult> {
    const pattern = input.pattern as string;
    const basePath = input.path
      ? this.resolveAndValidatePath(input.path as string)
      : this.workDir;

    // Use find + glob pattern via bash
    try {
      const { stdout } = await execFileAsync(
        "bash",
        ["-c", `find ${JSON.stringify(basePath)} -path ${JSON.stringify(basePath + "/" + pattern)} -type f 2>/dev/null | head -200 | sort`],
        { cwd: this.workDir, timeout: 15_000, maxBuffer: SHELL_MAX_OUTPUT }
      );
      return { output: stdout || "No files found matching pattern.", isError: false };
    } catch {
      // Fallback: use rg --files with glob
      try {
        const { stdout } = await execFileAsync(
          "rg",
          ["--files", "--glob", pattern, basePath],
          { cwd: this.workDir, timeout: 15_000, maxBuffer: SHELL_MAX_OUTPUT }
        );
        return { output: stdout || "No files found matching pattern.", isError: false };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `glob error: ${msg}`, isError: true };
      }
    }
  }

  /* ---------- git_ops ---------- */

  private async toolGitOps(input: Record<string, unknown>): Promise<ToolExecResult> {
    const operation = input.operation as string;
    const args = (input.args as string[]) ?? [];

    // Allowlist of git operations
    const allowed = new Set([
      "status", "diff", "log", "add", "commit", "branch", "checkout", "show",
      "stash", "rev-parse", "remote",
    ]);

    if (!allowed.has(operation)) {
      return {
        output: `Blocked: git ${operation} is not in the allowed operations list.`,
        isError: true,
      };
    }

    // Block dangerous flags
    const joinedArgs = args.join(" ");
    if (/--force|--hard|-D\b/.test(joinedArgs)) {
      return {
        output: `Blocked: destructive flag detected in "git ${operation} ${joinedArgs}".`,
        isError: true,
      };
    }

    try {
      const { stdout, stderr } = await execFileAsync(
        "git",
        [operation, ...args],
        { cwd: this.workDir, timeout: 30_000, maxBuffer: SHELL_MAX_OUTPUT }
      );
      const combined = [stdout, stderr].filter(Boolean).join("\n");
      return { output: combined || "(no output)", isError: false };
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; message?: string };
      const out = [execErr.stdout, execErr.stderr].filter(Boolean).join("\n");
      return { output: out || `git error: ${execErr.message ?? "unknown"}`, isError: true };
    }
  }

  /* ---------- code_search ---------- */

  private async toolCodeSearch(input: Record<string, unknown>): Promise<ToolExecResult> {
    const query = input.query as string;
    const fileType = input.file_type as string | undefined;
    const searchPath = input.path
      ? this.resolveAndValidatePath(input.path as string)
      : this.workDir;

    // Build pattern for common code definitions
    const patterns = [
      `(function|const|let|var|class|interface|type|enum|export)\\s+${query}`,
      `def ${query}`,
      `fn ${query}`,
      `func ${query}`,
    ];
    const combinedPattern = patterns.join("|");

    const args = [
      "--no-heading", "--line-number", "--color=never",
      "-C", "2", // 2 lines context
      "-m", "30",
    ];
    if (fileType) args.push("--type", fileType);
    args.push(combinedPattern, searchPath);

    try {
      const { stdout } = await execFileAsync("rg", args, {
        cwd: this.workDir,
        timeout: 30_000,
        maxBuffer: SHELL_MAX_OUTPUT,
      });
      return { output: stdout || `No definitions found for "${query}".`, isError: false };
    } catch (err: unknown) {
      const execErr = err as { code?: number; message?: string };
      if (execErr.code === 1) {
        return { output: `No definitions found for "${query}".`, isError: false };
      }
      return { output: `code_search error: ${execErr.message ?? "unknown"}`, isError: true };
    }
  }

  /* ---------- test_run ---------- */

  private async toolTestRun(input: Record<string, unknown>): Promise<ToolExecResult> {
    const testFile = input.test_file as string | undefined;
    const testName = input.test_name as string | undefined;
    let runner = input.runner as string | undefined;

    // Auto-detect test runner
    if (!runner) {
      try {
        const pkgJson = await fs.readFile(path.join(this.workDir, "package.json"), "utf-8");
        const pkg = JSON.parse(pkgJson);
        const deps = { ...pkg.devDependencies, ...pkg.dependencies };
        if (deps.vitest) runner = "vitest";
        else if (deps.jest) runner = "jest";
        else if (deps.mocha) runner = "mocha";
      } catch {
        // Check for pytest
        try {
          await fs.access(path.join(this.workDir, "pytest.ini"));
          runner = "pytest";
        } catch {
          runner = "jest"; // fallback
        }
      }
    }

    // Build command
    let command: string;
    switch (runner) {
      case "vitest":
        command = `npx vitest run${testFile ? ` ${testFile}` : ""}${testName ? ` -t "${testName}"` : ""} --reporter=verbose`;
        break;
      case "pytest":
        command = `python -m pytest${testFile ? ` ${testFile}` : ""}${testName ? ` -k "${testName}"` : ""} -v`;
        break;
      case "mocha":
        command = `npx mocha${testFile ? ` ${testFile}` : ""}${testName ? ` --grep "${testName}"` : ""} --reporter spec`;
        break;
      case "jest":
      default:
        command = `npx jest${testFile ? ` ${testFile}` : ""}${testName ? ` -t "${testName}"` : ""} --verbose --no-coverage`;
        break;
    }

    return this.toolShellExec({ command, timeout: 120_000 });
  }

  /* ------------------------------------------------------------------
   * Path Validation
   * ------------------------------------------------------------------ */

  /**
   * Resolve a path and validate it is within workDir.
   * Throws if the path escapes the sandbox.
   */
  private resolveAndValidatePath(filePath: string): string {
    const resolved = path.resolve(this.workDir, filePath);
    if (!resolved.startsWith(this.workDir)) {
      throw new Error(`Path traversal blocked: "${filePath}" resolves outside workDir.`);
    }
    return resolved;
  }

  /* ------------------------------------------------------------------
   * Approval Flow
   * ------------------------------------------------------------------ */

  /**
   * Check if a tool invocation requires user approval.
   */
  private requiresApproval(toolName: string, input: Record<string, unknown>): boolean {
    // shell_exec with potentially destructive commands
    if (toolName === "shell_exec") {
      const cmd = (input.command as string) ?? "";
      if (/git\s+push|npm\s+publish|pnpm\s+publish|yarn\s+publish/.test(cmd)) {
        return true;
      }
    }

    // Writing to sensitive files
    if (toolName === "file_write" || toolName === "file_edit") {
      const filePath = (input.path as string) ?? "";
      if (SENSITIVE_FILE_PATTERNS.some((p) => p.test(filePath))) {
        return true;
      }
    }

    // git commit/push
    if (toolName === "git_ops") {
      const op = input.operation as string;
      if (op === "commit" || op === "checkout") {
        return true;
      }
    }

    return false;
  }

  /**
   * Request approval from the user and wait for response.
   * Returns the user's response: "approve" | "reject" | "always_approve".
   */
  private async requestApproval(
    toolUse: ToolUseBlock
  ): Promise<"approve" | "reject" | "always_approve"> {
    const actionId = randomUUID();
    const input = toolUse.input as Record<string, unknown>;

    const risk = this.assessRisk(toolUse.name, input);
    const description = `${toolUse.name}: ${JSON.stringify(input).slice(0, 200)}`;

    AgentSessionManager.setPendingApproval(this.sessionId, {
      actionId,
      toolName: toolUse.name,
      toolInput: input,
      risk,
      description,
      requestedAt: Date.now(),
    });

    // Wait for approval response via EventEmitter
    return new Promise<"approve" | "reject" | "always_approve">((resolve) => {
      const session = AgentSessionManager.getSession(this.sessionId);
      if (!session) {
        resolve("reject");
        return;
      }

      const timeout = setTimeout(() => {
        session.emitter.removeListener("approval_response", handler);
        resolve("reject"); // Auto-reject after 5 minutes
      }, 5 * 60 * 1000);

      const handler = (data: { actionId: string; response: string }) => {
        if (data.actionId === actionId) {
          clearTimeout(timeout);
          session.emitter.removeListener("approval_response", handler);
          resolve(data.response as "approve" | "reject" | "always_approve");
        }
      };

      session.emitter.on("approval_response", handler);
    });
  }

  /**
   * Assess the risk level of a tool invocation.
   */
  private assessRisk(
    toolName: string,
    input: Record<string, unknown>
  ): "low" | "medium" | "high" {
    if (toolName === "shell_exec") {
      const cmd = (input.command as string) ?? "";
      if (/git\s+push|npm\s+publish/.test(cmd)) return "high";
      return "medium";
    }
    if (toolName === "file_write" || toolName === "file_edit") {
      const filePath = (input.path as string) ?? "";
      if (SENSITIVE_FILE_PATTERNS.some((p) => p.test(filePath))) return "high";
    }
    if (toolName === "git_ops") return "medium";
    return "low";
  }

  /* ------------------------------------------------------------------
   * Termination & Pause
   * ------------------------------------------------------------------ */

  /**
   * Check whether the loop should terminate.
   */
  private shouldTerminate(): boolean {
    if (this.interrupted === "hard" || this.interrupted === "soft") return true;
    if (this.iteration >= this.planLimits.maxIterations) {
      this.emitEvent("agent:error", {
        message: `Iteration limit reached (${this.planLimits.maxIterations})`,
      });
      return true;
    }
    if (
      this.planLimits.maxInputTokens &&
      this.totalInputTokens >= this.planLimits.maxInputTokens
    ) {
      this.emitEvent("agent:error", { message: "Input token budget exceeded" });
      return true;
    }
    if (
      this.planLimits.maxOutputTokens &&
      this.totalOutputTokens >= this.planLimits.maxOutputTokens
    ) {
      this.emitEvent("agent:error", { message: "Output token budget exceeded" });
      return true;
    }
    return false;
  }

  /**
   * Wait until the executor is resumed from a paused state.
   */
  private waitForResume(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pauseResolve = resolve;
    });
  }

  /* ------------------------------------------------------------------
   * Persistence (PostgreSQL)
   * ------------------------------------------------------------------ */

  /**
   * Persist an iteration to the agent_iterations table.
   */
  private async persistIteration(
    iterationId: string,
    content: ContentBlock[],
    toolCalls: ToolUseBlock[]
  ): Promise<void> {
    try {
      await pgPool.query(
        `INSERT INTO agent_iterations
           (id, session_id, run_id, iteration_number, content, tool_calls,
            input_tokens, output_tokens, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [
          iterationId,
          this.sessionId,
          this.runId,
          this.iteration,
          JSON.stringify(content),
          JSON.stringify(toolCalls.map((t) => ({ id: t.id, name: t.name, input: t.input }))),
          this.totalInputTokens,
          this.totalOutputTokens,
        ]
      );
    } catch (err: unknown) {
      // Non-fatal: log and continue
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[YUAN_AGENT] Failed to persist iteration:", msg);
    }
  }

  /**
   * Save a checkpoint for crash recovery.
   */
  private async saveCheckpoint(reason: string): Promise<void> {
    try {
      await pgPool.query(
        `INSERT INTO agent_checkpoints
           (id, session_id, run_id, iteration, messages, token_usage, reason, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (session_id) DO UPDATE SET
           iteration = EXCLUDED.iteration,
           messages = EXCLUDED.messages,
           token_usage = EXCLUDED.token_usage,
           reason = EXCLUDED.reason,
           created_at = NOW()`,
        [
          randomUUID(),
          this.sessionId,
          this.runId,
          this.iteration,
          JSON.stringify(this.messages.slice(-20)), // Keep last 20 messages for context
          JSON.stringify({ input: this.totalInputTokens, output: this.totalOutputTokens }),
          reason,
        ]
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[YUAN_AGENT] Failed to save checkpoint:", msg);
    }
  }

  /* ------------------------------------------------------------------
   * Helpers
   * ------------------------------------------------------------------ */

  /**
   * Emit an event via AgentSessionManager.
   */
  private emitEvent(kind: string, data: Record<string, unknown>): void {
    AgentSessionManager.emitEvent(this.sessionId, {
      kind: kind as import("./agent-session-manager").AgentEventKind,
      runId: this.runId,
      data,
    });
  }

  /**
   * Update token usage on the session object.
   */
  private updateSessionTokens(): void {
    const session = AgentSessionManager.getSession(this.sessionId);
    if (session) {
      session.tokenUsage = {
        input: this.totalInputTokens,
        output: this.totalOutputTokens,
      };
    }
  }

  /**
   * Promise-based sleep.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
