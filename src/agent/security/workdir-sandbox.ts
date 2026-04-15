// src/agent/security/workdir-sandbox.ts
// YUAN Coding Agent — Work Directory Sandboxing
//
// Creates isolated work directories for agent sessions.
// Phase 1: tmpfs-based isolation (fast, ephemeral).
// Phase 2: Docker per session (full isolation).

import * as fs from "fs/promises";
import * as path from "path";

const SESSIONS_BASE = "/var/yuan-sessions";
const TMP_BASE = "/tmp/yuan-agent";

/** Sandbox options */
export interface SandboxOptions {
  sessionId: string;
  /** Use persistent storage (default: false = ephemeral /tmp) */
  persistent?: boolean;
  /** Max directory size in bytes (not enforced at FS level in Phase 1) */
  maxSizeBytes?: number;
}

/** Sandbox result */
export interface SandboxResult {
  workDir: string;
  type: "persistent" | "ephemeral";
}

/**
 * Create a sandboxed work directory for an agent session.
 *
 * Phase 1: Creates a directory under /tmp/yuan-agent/ or /var/yuan-sessions/
 *   with restrictive permissions (0o700 — owner only).
 *
 * Phase 2 (TODO): Spawn a Docker container with:
 *   - tmpfs mount for workDir
 *   - read-only root filesystem
 *   - --network=none (no internet)
 *   - CPU/memory limits
 */
export async function createSandbox(options: SandboxOptions): Promise<SandboxResult> {
  const { sessionId, persistent = false } = options;

  // Sanitize sessionId — only allow UUID chars
  if (!/^[a-f0-9-]{36}$/i.test(sessionId)) {
    throw new Error("Invalid sessionId format for sandbox");
  }

  const baseDir = persistent ? SESSIONS_BASE : TMP_BASE;
  const workDir = path.join(baseDir, sessionId);

  // Ensure base directory exists
  await fs.mkdir(baseDir, { recursive: true, mode: 0o755 });

  // Create session directory with restrictive permissions
  await fs.mkdir(workDir, { recursive: true, mode: 0o700 });

  return {
    workDir,
    type: persistent ? "persistent" : "ephemeral",
  };
}

/**
 * Cleanup a sandbox work directory.
 * Removes the directory and all contents.
 */
export async function cleanupSandbox(workDir: string): Promise<void> {
  // Safety: only delete under known base paths
  const isUnderTmp = workDir.startsWith(TMP_BASE + "/");
  const isUnderSessions = workDir.startsWith(SESSIONS_BASE + "/");

  if (!isUnderTmp && !isUnderSessions) {
    console.error("[YUAN_SANDBOX] Refusing to delete:", workDir);
    return;
  }

  // Extra safety: path must have exactly one level under base
  const relativeParts = path.relative(
    isUnderTmp ? TMP_BASE : SESSIONS_BASE,
    workDir,
  ).split(path.sep);

  if (relativeParts.length !== 1 || relativeParts[0].includes("..")) {
    console.error("[YUAN_SANDBOX] Invalid path depth:", workDir);
    return;
  }

  try {
    await fs.rm(workDir, { recursive: true, force: true, maxRetries: 2 });
    console.log("[YUAN_SANDBOX] Cleaned up:", workDir);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[YUAN_SANDBOX] Cleanup failed:", workDir, msg);
  }
}

/**
 * Validate that a file path is within the sandbox.
 * Returns the resolved absolute path or throws.
 */
export function validatePath(workDir: string, filePath: string): string {
  const resolved = path.resolve(workDir, filePath);

  if (!resolved.startsWith(workDir + path.sep) && resolved !== workDir) {
    throw new Error(`Path traversal blocked: "${filePath}" resolves outside sandbox`);
  }

  // Block access to sensitive paths even within workDir
  const basename = path.basename(resolved).toLowerCase();
  const BLOCKED_BASENAMES = new Set([
    ".git/config",  // May contain credentials
    ".npmrc",       // May contain auth tokens
    ".yarnrc",
  ]);

  if (BLOCKED_BASENAMES.has(basename)) {
    throw new Error(`Access to "${basename}" is restricted inside sandbox`);
  }

  return resolved;
}
