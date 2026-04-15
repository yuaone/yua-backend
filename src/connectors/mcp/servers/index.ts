// src/connectors/mcp/servers/index.ts
// MCP server spec registry. Each provider points to the Streamable HTTP URL
// of the actual MCP server. Spec is thin — auth is the Bearer token we
// inject into the transport.
//
// IMPORTANT: these URLs are intentionally NOT populated with guesses.
// A provider is only considered "ready" when the corresponding MCP_*_URL
// env var is filled with a real server URL. getServerSpec() returns null
// for unconfigured providers, which causes client-manager to silently skip
// that connector instead of trying to connect to a nonexistent host.

export interface McpServerSpec {
  id: string;
  name: string;
  serverUrl: string;
}

function envUrl(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v || v === "xx") return "";
  // Defense-in-depth: require https://
  if (!v.startsWith("https://") && !v.startsWith("http://127.0.0.1")) {
    console.warn(`[mcp-servers] ${name} must be https:// — ignoring "${v}"`);
    return "";
  }
  return v;
}

const RAW_SPECS: Record<string, { id: string; name: string; envKey: string }> = {
  github:          { id: "github",          name: "GitHub",          envKey: "MCP_GITHUB_URL"        },
  gdrive:          { id: "gdrive",          name: "Google Drive",    envKey: "MCP_GDRIVE_URL"        },
  gmail:           { id: "gmail",           name: "Gmail",           envKey: "MCP_GMAIL_URL"         },
  context7:        { id: "context7",        name: "Context7",        envKey: "MCP_CONTEXT7_URL"      },
  huggingface:     { id: "huggingface",     name: "Hugging Face",    envKey: "MCP_HUGGINGFACE_URL"   },
  google_calendar: { id: "google_calendar", name: "Google Calendar", envKey: "MCP_GCAL_URL"          },
};

export function getServerSpec(provider: string): McpServerSpec | null {
  const raw = RAW_SPECS[provider];
  if (!raw) return null;
  const url = envUrl(raw.envKey);
  if (!url) return null; // provider not configured → silently skip
  return { id: raw.id, name: raw.name, serverUrl: url };
}

export function listConfiguredProviders(): string[] {
  return Object.keys(RAW_SPECS).filter((k) => getServerSpec(k) !== null);
}

/**
 * Resolve MCP server URL for a connector.
 * Priority: DB server_url > env-based hardcoded spec.
 */
export function resolveServerUrlFromRow(row: {
  server_url?: string | null;
  serverUrl?: string | null;
  provider: string;
}): string | null {
  // 1. DB-stored URL (custom connectors) — accept both snake_case (raw DB) and camelCase (mapped)
  const dbUrl = row.server_url || row.serverUrl;
  if (dbUrl && dbUrl.trim().length > 0) {
    return dbUrl.trim();
  }
  // 2. Fallback: hardcoded env-based spec
  const spec = getServerSpec(row.provider);
  return spec?.serverUrl ?? null;
}
