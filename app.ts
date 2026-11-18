// @ts-nocheck — the runtime strips types; there is no type-checking step in the trial pod.
// The forge's server: one process, one listener, four surfaces.
//
//   /healthz                                  the env's boot probe
//   /{owner}/{repo}.git/...                   git smart HTTP (githttp.ts)
//   /api/v3/...                               GitHub REST v3 (rest.ts)
//   /api/graphql                              GitHub GraphQL v4 (graphql.ts)
//   /mcp                                      Model Context Protocol (mcp.ts)
//
// Every API call presents the trial's bearer token; a request without it is 401. A repository
// belongs to the login the token names, so the same name under another owner is a 404.

import { createServer } from 'node:http';
import { Forge } from './forge.ts';
import { handleGit } from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { bearerOf, messageOf, segmentsOf, sendJson } from './http.ts';

/**
 * Whether the request carries the trial's token. The suite presents it as a bearer token; a real git
 * client sends it as the password of Basic auth (`http://user:token@host/...`), so both are taken.
 * An unset token accepts anything a client presents (a hand-run server).
 */
function authorized(req, token) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const text = header.trim();
  let presented = null;
  const bearer = /^Bearer\s+(.+)$/i.exec(text);
  if (bearer !== null) presented = bearer[1].trim();
  else {
    const basic = /^Basic\s+(.+)$/i.exec(text);
    if (basic !== null) {
      const decoded = Buffer.from(basic[1].trim(), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      presented = colon < 0 ? decoded : decoded.slice(colon + 1);
    }
  }
  if (presented === null) return false;
  if (token === '') return presented !== '';
  return presented === token;
}

async function dispatch(forge, token, req, res) {
  const parsed = segmentsOf(req.url ?? '/');
  if (parsed === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const { path, query, segments } = parsed;
  const method = req.method ?? 'GET';

  if (path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === '/mcp' || path === '/mcp/') {
    await handleMcp(forge, req, res, token);
    return;
  }

  if (path === '/api/graphql' || path === '/api/graphql/') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'POST /api/graphql takes a JSON body' });
      return;
    }
    if (!authorized(req, token)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    await handleGraphQL(forge, req, res);
    return;
  }

  if (segments[0] === 'api' && segments[1] === 'v3') {
    if (!authorized(req, token)) {
      sendJson(res, 401, { message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' });
      return;
    }
    await handleRest(forge, req, res, segments.slice(2), query);
    return;
  }

  if (segments.length >= 2 && segments[1].endsWith('.git')) {
    if (!authorized(req, token)) {
      // A real git client only sends the credentials in its URL after a Basic challenge.
      sendJson(res, 401, { message: 'Requires authentication' }, { 'www-authenticate': 'Basic realm="makefun-forge"' });
      return;
    }
    if (await handleGit(forge, req, res, segments, query)) return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the entry listens on its ephemeral port. */
export function createApp() {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const server = createServer((req, res) => {
    dispatch(forge, token, req, res).catch((error) => {
      process.stderr.write(`[forge] ${req.method} ${req.url} failed: ${messageOf(error)}\n`);
      try {
        sendJson(res, 500, { message: 'the forge failed to answer this request' });
      } catch {
        // The response was already written.
      }
    });
  });
  // The benchmark reads 2,000 issues over one keep-alive connection: keep it alive generously.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  return server;
}
