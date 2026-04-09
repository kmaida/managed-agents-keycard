// anthropic-api.ts — Thin wrapper for Managed Agents API calls

import { API_BASE, API_VERSION, BETA_HEADER } from "./types.js";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");

const headers = {
  "x-api-key": apiKey,
  "anthropic-version": API_VERSION,
  "anthropic-beta": BETA_HEADER,
  "content-type": "application/json",
};

export async function apiCall<T = unknown>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Opens an SSE stream to the session and yields parsed event objects.
 * Caller is responsible for closing via the returned AbortController.
 */
export async function* streamSession(
  sessionId: string,
  signal?: AbortSignal
): AsyncGenerator<{ type: string; [key: string]: unknown }> {
  const url = `${API_BASE}/sessions/${sessionId}/stream?beta=true`;
  const res = await fetch(url, {
    headers: { ...headers, Accept: "text/event-stream" },
    signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text();
    throw new Error(`Stream failed (${res.status}): ${text}`);
  }

  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const json = line.slice(6).trim();
      if (!json || json === "[DONE]") continue;
      try {
        yield JSON.parse(json);
      } catch {
        // skip malformed lines
      }
    }
  }
}

export async function sendEvents(
  sessionId: string,
  events: unknown[]
): Promise<void> {
  await apiCall("POST", `/sessions/${sessionId}/events?beta=true`, { events });
}
