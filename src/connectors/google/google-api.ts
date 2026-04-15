// src/connectors/google/google-api.ts
// Direct Google API integration — replaces Docker MCP server for Google Workspace.
// Uses stored OAuth tokens from user_connectors (managed by token-store.ts).
// Each function takes an accessToken and calls googleapis SDK directly.

import { google } from "googleapis";

function makeAuth(accessToken: string) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return auth;
}

// ── Gmail ──

export async function searchGmail(
  accessToken: string,
  query: string,
  maxResults = 10,
): Promise<string> {
  const auth = makeAuth(accessToken);
  const gmail = google.gmail({ version: "v1", auth });

  const list = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults,
  });

  if (!list.data.messages?.length) {
    return `No emails found for query: "${query}"`;
  }

  // Fetch details for each message
  const details = await Promise.all(
    list.data.messages.slice(0, maxResults).map(async (msg) => {
      const detail = await gmail.users.messages.get({
        userId: "me",
        id: msg.id!,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
      });
      const headers = detail.data.payload?.headers ?? [];
      const get = (name: string) => headers.find((h) => h.name === name)?.value ?? "";
      return {
        id: msg.id,
        from: get("From"),
        to: get("To"),
        subject: get("Subject"),
        date: get("Date"),
        snippet: detail.data.snippet ?? "",
      };
    }),
  );

  return JSON.stringify(details, null, 2);
}

export async function getGmailMessage(
  accessToken: string,
  messageId: string,
): Promise<string> {
  const auth = makeAuth(accessToken);
  const gmail = google.gmail({ version: "v1", auth });

  const detail = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const headers = detail.data.payload?.headers ?? [];
  const get = (name: string) => headers.find((h) => h.name === name)?.value ?? "";

  // Extract body text
  let body = "";
  const parts = detail.data.payload?.parts;
  if (parts) {
    const textPart = parts.find((p) => p.mimeType === "text/plain");
    if (textPart?.body?.data) {
      body = Buffer.from(textPart.body.data, "base64url").toString("utf-8");
    }
  } else if (detail.data.payload?.body?.data) {
    body = Buffer.from(detail.data.payload.body.data, "base64url").toString("utf-8");
  }

  return JSON.stringify({
    id: messageId,
    from: get("From"),
    to: get("To"),
    subject: get("Subject"),
    date: get("Date"),
    body: body.slice(0, 5000), // cap at 5K chars
    labels: detail.data.labelIds,
  }, null, 2);
}

export async function sendGmail(
  accessToken: string,
  to: string,
  subject: string,
  body: string,
): Promise<string> {
  const auth = makeAuth(accessToken);
  const gmail = google.gmail({ version: "v1", auth });

  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`,
  ).toString("base64url");

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });

  return JSON.stringify({ ok: true, messageId: res.data.id });
}

// ── Google Drive ──

export async function searchDrive(
  accessToken: string,
  query: string,
  maxResults = 10,
): Promise<string> {
  const auth = makeAuth(accessToken);
  const drive = google.drive({ version: "v3", auth });

  const res = await drive.files.list({
    q: query ? `fullText contains '${query.replace(/'/g, "\\'")}'` : undefined,
    pageSize: maxResults,
    fields: "files(id, name, mimeType, modifiedTime, size, webViewLink)",
    orderBy: "modifiedTime desc",
  });

  if (!res.data.files?.length) {
    return `No files found for query: "${query}"`;
  }

  return JSON.stringify(res.data.files, null, 2);
}

export async function getDriveFile(
  accessToken: string,
  fileId: string,
): Promise<string> {
  const auth = makeAuth(accessToken);
  const drive = google.drive({ version: "v3", auth });

  const meta = await drive.files.get({
    fileId,
    fields: "id, name, mimeType, modifiedTime, size, webViewLink, description",
  });

  // For Google Docs/Sheets/Slides, export as text
  const mimeType = meta.data.mimeType ?? "";
  let content = "";
  if (mimeType.startsWith("application/vnd.google-apps.")) {
    try {
      const exportRes = await drive.files.export({
        fileId,
        mimeType: "text/plain",
      });
      content = typeof exportRes.data === "string" ? exportRes.data.slice(0, 10000) : "";
    } catch {
      content = "(Export not available for this file type)";
    }
  }

  return JSON.stringify({
    ...meta.data,
    content: content || undefined,
  }, null, 2);
}

// ── Google Calendar ──

export async function listCalendarEvents(
  accessToken: string,
  timeMin?: string,
  timeMax?: string,
  maxResults = 10,
): Promise<string> {
  const auth = makeAuth(accessToken);
  const calendar = google.calendar({ version: "v3", auth });

  const now = new Date();
  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: timeMin ?? now.toISOString(),
    timeMax: timeMax ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    maxResults,
    singleEvents: true,
    orderBy: "startTime",
  });

  if (!res.data.items?.length) {
    return "No upcoming events found.";
  }

  const events = res.data.items.map((e) => ({
    id: e.id,
    summary: e.summary,
    start: e.start?.dateTime ?? e.start?.date,
    end: e.end?.dateTime ?? e.end?.date,
    location: e.location,
    description: e.description?.slice(0, 500),
    attendees: e.attendees?.map((a) => a.email),
    link: e.htmlLink,
  }));

  return JSON.stringify(events, null, 2);
}

export async function createCalendarEvent(
  accessToken: string,
  summary: string,
  startTime: string,
  endTime: string,
  description?: string,
  location?: string,
): Promise<string> {
  const auth = makeAuth(accessToken);
  const calendar = google.calendar({ version: "v3", auth });

  const res = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary,
      description,
      location,
      start: { dateTime: startTime },
      end: { dateTime: endTime },
    },
  });

  return JSON.stringify({
    ok: true,
    eventId: res.data.id,
    link: res.data.htmlLink,
  });
}
