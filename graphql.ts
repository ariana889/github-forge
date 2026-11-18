// @ts-nocheck — the runtime strips types; there is no type-checking step in the trial pod.
// The GraphQL v4 endpoint. The executor lives in graphql-exec.ts; this module is the HTTP edge.

import { sendJson } from './http.ts';

export async function handleGraphQL(forge, req, res) {
  sendJson(res, 200, { data: null, errors: [{ message: 'the GraphQL executor is not wired yet' }] });
}
