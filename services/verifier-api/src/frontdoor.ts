// Front door logic: round-robin forwarding, rate limiting and the status data for the verifier screen.
// It does not know how instances are started or reached; proxy.ts supplies that. This keeps it testable:
// the tests plug in in-process instances instead of real network calls.
import { Hono, type Context } from 'hono';
import { LOAD_TEST_VERIFIER_ID, isAllowedOrigin, isLoopback } from '@true/shared';
import { cors } from 'hono/cors';
import { createFailureLimiter, createRateCounter } from '@true/shared';

// One verifier instance as the front door sees it.
export type Backend = {
  name: string;
  port: number;
  alive: boolean;
  health: Record<string, unknown>; // last /health answer (last synced, counters, uptime)
  forward: (path: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>;
};

// All configurable in .env (see .env.example).
export type Limits = {
  failMax: number; // failed verification attempts ...
  failWindowSeconds: number; // ... inside this window ...
  blockSeconds: number; // ... block the source for this long
  createMax: number; // request creations allowed per source per minute
};
export const DEFAULT_LIMITS: Limits = { failMax: 5, failWindowSeconds: 60, blockSeconds: 60, createMax: 120 };

const LOAD_TEST_MAX_PER_MINUTE = 1000;

export type BlockEvent = { at: string; source: string; verifierId: string; seconds: number };

export function createFrontDoor(options: {
  backends: Backend[];
  limits?: Limits;
  now?: () => number; // clock in milliseconds; tests replace it
  getSource: (c: Context) => string; // who is calling (the IP address)
  hashSource: (text: string) => string; // one-way hash, so logs and screens never show an IP address
  controls?: { kill: (name: string) => void; restart: (name: string) => void };
  onBlock?: (event: BlockEvent) => void; // called once when a source gets blocked (for the audit log)
  localOnlyOps?: boolean; // true on the real front door: /proxy/* answers only to this machine
}) {
  const { backends } = options;
  const limits = options.limits ?? DEFAULT_LIMITS;
  const now = options.now ?? Date.now;
  const failureLimiter = createFailureLimiter({ max: limits.failMax, windowSeconds: limits.failWindowSeconds, blockSeconds: limits.blockSeconds, now });
  const createCounter = createRateCounter({ max: limits.createMax, windowSeconds: 60, now });
  // The load test button has its own, larger bucket: it must not be stopped by the normal limit,
  // and it must not use up the allowance of real kiosks.
  const loadTestCounter = createRateCounter({ max: LOAD_TEST_MAX_PER_MINUTE, windowSeconds: 60, now });

  const blockEvents: BlockEvent[] = []; // newest first
  // Which verifier each request belongs to, learned when the request is created through this door.
  // Needed because a failed attempt is counted per source AND per verifier.
  const requestVerifier = new Map<string, string>();

  const app = new Hono();
  // exposeHeaders lets a browser page read these headers.
  app.use('*', cors({ origin: (origin) => (isAllowedOrigin(origin) ? origin : null), exposeHeaders: ['X-Served-By', 'Retry-After'] }));

  // Operations routes (status, kill, restart) are for the laptop only: a phone on the Wi-Fi gets 403.
  app.use('/proxy/*', async (c, next) => {
    if (options.localOnlyOps && !isLoopback(options.getSource(c))) {
      return c.json({ error: { code: 'forbidden', message: 'Operations routes are only reachable from the server machine itself' } }, 403);
    }
    await next();
  });

  const tooMany = (c: Context, code: string, seconds: number) => {
    c.header('Retry-After', String(seconds));
    return c.json({ error: { code, message: `Too many attempts, try again in ${seconds} seconds`, retryAfterSeconds: seconds } }, 429);
  };

  // ---------- status and demo controls ----------

  app.get('/proxy/status', (c) =>
    c.json({
      // Health details first, then our own view of "alive" on top (the last health answer may be out of date).
      instances: backends.map((b) => ({ ...b.health, name: b.name, port: b.port, alive: b.alive })),
      blocked: { active: failureLimiter.blockedCount(), total: blockEvents.length, recent: blockEvents.slice(0, 5) },
      limits,
      now: now(),
    }),
  );

  // Stop or start one instance, or all of them with the name "all".
  const names = (name: string) => backends.filter((b) => name === 'all' || b.name === name).map((b) => b.name);
  app.post('/proxy/kill/:name', (c) => { names(c.req.param('name')).forEach((n) => options.controls?.kill(n)); return c.json({ ok: true }); });
  app.post('/proxy/restart/:name', (c) => { names(c.req.param('name')).forEach((n) => options.controls?.restart(n)); return c.json({ ok: true }); });

  // The internal sync endpoints are never reachable through the front door.
  app.all('/internal/*', (c) => c.json({ error: { code: 'forbidden', message: 'Not available here' } }, 403));

  // ---------- forwarding ----------

  // Send to the next alive instance in turn. If that forward fails, try another alive one.
  let turn = 0;
  async function forward(c: Context, body: string | undefined): Promise<Response> {
    const url = new URL(c.req.url);
    const alive = backends.filter((b) => b.alive);
    turn += 1;
    for (let attempt = 0; attempt < alive.length; attempt++) {
      const backend = alive[(turn + attempt) % alive.length];
      try {
        const response = await backend.forward(url.pathname + url.search, {
          method: c.req.method,
          headers: {
            'content-type': c.req.header('content-type') ?? 'application/json',
            authorization: c.req.header('authorization') ?? '',
            'x-public-origin': url.origin, // how the caller reached us; the instance builds links from it
          },
          body,
        });
        return new Response(await response.text(), {
          status: response.status,
          headers: { 'content-type': 'application/json', 'X-Served-By': `instance ${backend.name}` },
        });
      } catch {
        backend.alive = false; // could not connect: treat as dead and try the next one
      }
    }
    return Response.json({ error: { code: 'no_server_available', message: 'No server available right now. Please try again in a few seconds.' } }, { status: 503 });
  }

  // Creating a request: a generous limit per source (API key if one is sent, otherwise the IP address).
  app.post('/v1/requests', async (c) => {
    const body = await c.req.text();
    const source = c.req.header('x-api-key') || options.getSource(c);
    const isLoadTest = body.includes(LOAD_TEST_VERIFIER_ID);
    const wait = (isLoadTest ? loadTestCounter : createCounter).hit(source);
    if (wait > 0) return tooMany(c, 'too_many_requests', wait);

    const response = await forward(c, body);
    if (response.status === 201) {
      // Remember which verifier this request is for (keep the map small: drop the oldest entries).
      const created = await response.clone().json();
      requestVerifier.set(created.requestId, JSON.parse(body).verifierId);
      if (requestVerifier.size > 5000) requestVerifier.delete(requestVerifier.keys().next().value!);
    }
    return response;
  });

  // Answering a request: failed attempts are counted per source + verifier.
  app.post('/v1/requests/:id/response', async (c) => {
    const verifierId = requestVerifier.get(c.req.param('id')) ?? 'unknown';
    const source = `${options.getSource(c)}|${verifierId}`;
    const wait = failureLimiter.retryAfter(source);
    if (wait > 0) return tooMany(c, 'too_many_attempts', wait);

    const response = await forward(c, await c.req.text());
    // A failure is an error reply, or a presentation the verifier denied. A user pressing Decline is not a failure,
    // and "no server available" is our problem, not the caller's.
    const result = await response.clone().json().catch(() => ({}));
    const failed = response.status !== 503 && (response.status >= 400 || (result.state === 'denied' && result.code !== 'user_declined'));
    if (failed && failureLimiter.recordFailure(source)) {
      const event = { at: new Date(now()).toISOString(), source: options.hashSource(source), verifierId, seconds: limits.blockSeconds };
      blockEvents.unshift(event);
      options.onBlock?.(event);
    }
    return response;
  });

  // Everything else is forwarded as it is.
  app.all('*', async (c) => forward(c, ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.text()));

  return app;
}
