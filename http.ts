// @ts-nocheck — the runtime strips types; there is no type-checking step in the trial pod.
// The small HTTP plumbing every surface shares: JSON replies, body reads, and path splitting.

import type { IncomingMessage, ServerResponse } from 'node:http';

/** The content type every REST reply carries. */
export const JSON_TYPE = 'application/json; charset=utf-8';

/** A per-process request id: the header the rules require on every REST reply. */
let requestCounter = 0;

export function nextRequestId() {
  requestCounter += 1;
  return `makefun-forge-${requestCounter}`;
}

/** Answer with a JSON body; `headers` go beside the JSON and cache ones. */
export function sendJson(res, status, body, headers) {
  const text = typeof body === 'string' ? body : `${JSON.stringify(body)}\n`;
  const base = {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
  };
  try {
    res.writeHead(status, { ...base, ...(headers ?? {}) });
    res.end(text);
  } catch {
    // The peer went away; there is nobody left to answer.
  }
}

/** Answer with raw bytes and an explicit content type (the git smart-HTTP services). */
export function sendBytes(res, status, contentType, body, headers) {
  try {
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': body.length,
      'cache-control': 'no-cache, max-age=0, must-revalidate',
      pragma: 'no-cache',
      expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
      ...(headers ?? {}),
    });
    res.end(body);
  } catch {
    // The peer went away between the request and the answer.
  }
}

/** Answer with no body at all (204 and the MCP notification answer). */
export function sendEmpty(res, status, headers) {
  try {
    res.writeHead(status, { 'content-length': '0', 'x-github-request-id': nextRequestId(), ...(headers ?? {}) });
    res.end();
  } catch {
    // The peer went away.
  }
}

/** Read a whole request body; null when it is past `limit` bytes. */
export async function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Read a JSON body: {ok: true, value} or {ok: false} when it is absent or not JSON. */
export async function readJson(req: IncomingMessage, limit = 4 * 1024 * 1024): Promise<{ ok: boolean; value?: unknown; tooLarge?: boolean }> {
  const raw = await readBody(req, limit);
  if (raw === null) return { ok: false, tooLarge: true };
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

/** The decoded path segments of a request URL, or null when it does not parse. */
export function segmentsOf(url: string): { path: string; query: URLSearchParams; segments: string[] } | null {
  let parsed: URL;
  try {
    parsed = new URL(url, 'http://forge.invalid');
  } catch {
    return null;
  }
  const segments = parsed.pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  return { path: parsed.pathname, query: parsed.searchParams, segments };
}

/** A short, single-line message for a log or an error body. */
export function messageOf(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.replace(/\s+/g, ' ').trim();
}

/** The Authorization bearer token of a request, or null. */
export function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? null : match[1].trim();
}

export type { IncomingMessage, ServerResponse };
