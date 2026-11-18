// The entry's life, as the env's wire settles it: bind an ephemeral port, tell the env the port the
// kernel gave us, serve until the suite says it is over, then exit 0. The forge itself is app.ts and
// the modules beside it; this file is only the handshake and the wait.
//
//   1. $MAKEFUN_ENV_URL is the env's origin. Without it there is nobody to register with: exit 1.
//   2. listen(0): the kernel picks a free port. Never 8080 — that one is the env's.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register, retrying while the env is still coming up. The
//      env records the address this request came from plus N and dials it from then on. The first
//      register wins: a 409 means another entry already took the slot, which is not ours to fix.
//   4. GET $MAKEFUN_ENV_URL/done until the body answers {"done": true}. The env answers at once (it
//      does not hold the request), so this is a poll with a short backoff and it never returns early.
//   5. Close the listener and exit 0; the harness then stops the env, which writes the export.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** One register or done request may take this long before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The first wait between attempts, and the longest one. */
const RETRY_FIRST_MS = 250;
const RETRY_LAST_MS = 2_000;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed attempts: exponential from the first wait, capped. */
function backoff(attempt: number): number {
  return Math.min(RETRY_LAST_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/** Announce the bound port until the env takes it. 400 and 405 are contract errors; the rest retry. */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (text.startsWith('register answered HTTP ')) throw error;
    }
    await wait(backoff(attempt));
  }
}

/** Poll GET /done until the suite says it is over; never returns before that. */
async function untilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or this poll timed out: it is not done, so poll again.
    }
    await wait(backoff(attempt));
  }
}

/** The whole life of the process: listen, register, wait, close. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await untilDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (error) {
  process.stderr.write(`[entry] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
