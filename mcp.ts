// @ts-nocheck — the runtime strips types; there is no type-checking step in the trial pod.
// The MCP endpoint: JSON-RPC 2.0 over the streamable-HTTP transport.

import { sendJson } from './http.ts';

export async function handleMcp(forge, req, res, token) {
  sendJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'the MCP surface is not wired yet' } });
}
