// src/connectors/google/google-tool-dispatcher.ts
// Dispatches Google Workspace tool calls directly via googleapis SDK.
// Replaces the Docker MCP server for Gmail, Drive, Calendar.

import { loadConnectorWithSecrets, isGoogleProvider, isTokenLikelyExpired, refreshGoogleToken } from "../oauth/token-store.js";
import * as GoogleAPI from "./google-api.js";

// Map of tool name → { provider, handler }
const GOOGLE_TOOLS: Record<string, {
  provider: string;
  handler: (token: string, args: any) => Promise<string>;
}> = {
  google_gmail_search: {
    provider: "gmail",
    handler: (token, args) => GoogleAPI.searchGmail(token, args.query ?? "is:unread", args.maxResults ?? 10),
  },
  google_gmail_read: {
    provider: "gmail",
    handler: (token, args) => GoogleAPI.getGmailMessage(token, args.messageId),
  },
  google_gmail_send: {
    provider: "gmail",
    handler: (token, args) => GoogleAPI.sendGmail(token, args.to, args.subject, args.body),
  },
  google_drive_search: {
    provider: "gdrive",
    handler: (token, args) => GoogleAPI.searchDrive(token, args.query ?? "", args.maxResults ?? 10),
  },
  google_drive_read: {
    provider: "gdrive",
    handler: (token, args) => GoogleAPI.getDriveFile(token, args.fileId),
  },
  google_calendar_list: {
    provider: "google_calendar",
    handler: (token, args) => GoogleAPI.listCalendarEvents(token, args.timeMin, args.timeMax, args.maxResults ?? 10),
  },
  google_calendar_create: {
    provider: "google_calendar",
    handler: (token, args) => GoogleAPI.createCalendarEvent(token, args.summary, args.startTime, args.endTime, args.description, args.location),
  },
};

export function isGoogleTool(toolName: string): boolean {
  return toolName in GOOGLE_TOOLS;
}

export function getGoogleToolNames(): string[] {
  return Object.keys(GOOGLE_TOOLS);
}

/**
 * Execute a Google tool call. Handles token refresh automatically.
 * Returns the result string or throws on error.
 */
export async function dispatchGoogleTool(
  userId: number,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const entry = GOOGLE_TOOLS[toolName];
  if (!entry) throw new Error(`Unknown Google tool: ${toolName}`);

  // Load token, auto-refresh if expired
  let withSecrets = await loadConnectorWithSecrets(userId, entry.provider);
  if (!withSecrets?.accessToken) {
    throw new Error(`Google ${entry.provider} not connected. Please connect in Settings > Connectors.`);
  }

  let token = withSecrets.accessToken;

  // Auto-refresh if token is likely expired
  if (isTokenLikelyExpired(withSecrets.updatedAt)) {
    console.log("[GOOGLE_TOOL] token expired, refreshing", { userId, provider: entry.provider });
    const refreshed = await refreshGoogleToken(userId, entry.provider);
    if (refreshed) {
      token = refreshed;
    }
    // If refresh fails, try with old token anyway — Google might still accept it
  }

  try {
    return await entry.handler(token, args);
  } catch (err: any) {
    // If 401, try one more refresh + retry
    if (err?.code === 401 || err?.status === 401 || err?.message?.includes("401")) {
      console.log("[GOOGLE_TOOL] 401, attempting refresh + retry", { userId, provider: entry.provider });
      const refreshed = await refreshGoogleToken(userId, entry.provider);
      if (refreshed) {
        return await entry.handler(refreshed, args);
      }
    }
    throw err;
  }
}

/**
 * OpenAI function tool definitions for Google Workspace.
 * Registered in execution-engine alongside other native tools.
 */
export function getGoogleToolDefinitions(): Array<{
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}> {
  return [
    {
      type: "function",
      name: "google_gmail_search",
      description: "Search the user's Gmail inbox. Returns email metadata (from, to, subject, date, snippet). Use for: checking recent emails, finding specific messages, inbox overview.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Gmail search query. Examples: 'is:unread', 'from:boss@company.com', 'subject:invoice after:2026/04/01'. Default: 'is:unread'." },
          maxResults: { type: "number", description: "Max emails to return (1-20). Default 10." },
        },
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "google_gmail_read",
      description: "Read a specific Gmail message by ID. Returns full email body, headers, and labels. Use after google_gmail_search to read a specific email.",
      parameters: {
        type: "object",
        properties: {
          messageId: { type: "string", description: "Gmail message ID from search results." },
        },
        required: ["messageId"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "google_gmail_send",
      description: "Send an email via Gmail. REQUIRES user confirmation before sending.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address." },
          subject: { type: "string", description: "Email subject line." },
          body: { type: "string", description: "Plain text email body." },
        },
        required: ["to", "subject", "body"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "google_drive_search",
      description: "Search Google Drive files. Returns file metadata (name, type, modified date, link). Use for: finding documents, listing recent files.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query for file names/content. Empty string lists recent files." },
          maxResults: { type: "number", description: "Max files to return (1-20). Default 10." },
        },
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "google_drive_read",
      description: "Read a Google Drive file by ID. Returns file metadata and content (text export for Google Docs/Sheets/Slides).",
      parameters: {
        type: "object",
        properties: {
          fileId: { type: "string", description: "Drive file ID from search results." },
        },
        required: ["fileId"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "google_calendar_list",
      description: "List upcoming Google Calendar events. Returns event details (title, time, location, attendees). Default: next 7 days.",
      parameters: {
        type: "object",
        properties: {
          timeMin: { type: "string", description: "Start time (ISO 8601). Default: now." },
          timeMax: { type: "string", description: "End time (ISO 8601). Default: 7 days from now." },
          maxResults: { type: "number", description: "Max events to return (1-20). Default 10." },
        },
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "google_calendar_create",
      description: "Create a Google Calendar event. REQUIRES user confirmation before creating.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Event title." },
          startTime: { type: "string", description: "Start time (ISO 8601)." },
          endTime: { type: "string", description: "End time (ISO 8601)." },
          description: { type: "string", description: "Event description (optional)." },
          location: { type: "string", description: "Event location (optional)." },
        },
        required: ["summary", "startTime", "endTime"],
        additionalProperties: false,
      },
    },
  ];
}
