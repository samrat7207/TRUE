// Front door on port 4000. The wallet and the verifier screen talk ONLY to this.
// It starts the verifier instances, checks their health every 2 seconds,
// and spreads requests across the instances that are alive (round-robin).
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { randomToken } from '@true/credentials';

// The internal key comes from .env. If there is no .env we make a random one for this run,
// so "npm run dev" still works on a fresh checkout.
const ENV_FILE = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const INTERNAL_KEY = process.env.INTERNAL_SYNC_KEY || randomToken();

// How many instances to run (default 3). Instance N listens on 4002, 4012, 4022, ... and uses verifier-N.db.
// FRONT_DOOR_PORT and INSTANCE_BASE_PORT exist only so a test run can use spare ports.
const COUNT = Number(process.env.VERIFIER_INSTANCES ?? 3);
const FRONT_PORT = Number(process.env.FRONT_DOOR_PORT ?? 4000);
const BASE_PORT = Number(process.env.INSTANCE_BASE_PORT ?? 4002);

type Instance = { name: string; port: number; alive: boolean; lastSyncedAt: number | null; child: ChildProcess | null };
const instances: Instance[] = Array.from({ length: COUNT }, (_, i) => ({
  name: String(i + 1), port: BASE_PORT + i * 10, alive: false, lastSyncedAt: null, child: null,
}));
const urlOf = (instance: Instance) => `http://localhost:${instance.port}`;

function start(instance: Instance) {
  if (instance.child) return;
  const peers = instances.filter((other) => other !== instance).map(urlOf).join(',');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.ts', import.meta.url))], {
    env: { ...process.env, INSTANCE: instance.name, PORT: String(instance.port), PEER_URLS: peers, INTERNAL_SYNC_KEY: INTERNAL_KEY },
    stdio: 'inherit',
  });
  child.on('exit', () => { instance.child = null; instance.alive = false; });
  instance.child = child;
}

function kill(instance: Instance) {
  instance.child?.kill();
  instance.alive = false;
}

// Health check: every 2 seconds ask each instance if it is alive and when it last synced.
// A dead instance that comes back is noticed here, so the front door recovers on its own.
async function checkHealth() {
  await Promise.all(instances.map(async (instance) => {
    try {
      const body = await (await fetch(urlOf(instance) + '/health', { signal: AbortSignal.timeout(1000) })).json();
      instance.alive = true;
      instance.lastSyncedAt = body.lastSyncedAt;
    } catch {
      instance.alive = false;
    }
  }));
}
setInterval(checkHealth, 2000);

const app = new Hono();
// exposeHeaders lets the browser page read X-Served-By.
app.use('*', cors({ origin: '*', exposeHeaders: ['X-Served-By'] }));

// Status cards for the verifier screen.
app.get('/proxy/status', (c) =>
  c.json({ instances: instances.map((i) => ({ name: i.name, port: i.port, alive: i.alive, lastSyncedAt: i.lastSyncedAt })), now: Date.now() }),
);

// Demo buttons: stop or start one instance, or all of them with the name "all".
const pick = (name: string) => instances.filter((i) => name === 'all' || i.name === name);
app.post('/proxy/kill/:name', (c) => { pick(c.req.param('name')).forEach(kill); return c.json({ ok: true }); });
app.post('/proxy/restart/:name', (c) => { pick(c.req.param('name')).forEach(start); return c.json({ ok: true }); });

// The internal sync endpoints are never reachable through the front door.
app.all('/internal/*', (c) => c.json({ error: { code: 'forbidden', message: 'Not available here' } }, 403));

// Everything else: forward to the next alive instance in turn. If that forward fails, try another.
let turn = 0;
app.all('*', async (c) => {
  const url = new URL(c.req.url);
  const body = ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.text();
  const alive = instances.filter((i) => i.alive);
  turn += 1;
  for (let attempt = 0; attempt < alive.length; attempt++) {
    const instance = alive[(turn + attempt) % alive.length];
    try {
      const response = await fetch(urlOf(instance) + url.pathname + url.search, {
        method: c.req.method,
        headers: { 'content-type': c.req.header('content-type') ?? 'application/json' },
        body,
        signal: AbortSignal.timeout(5000),
      });
      return c.body(await response.text(), response.status as 200, { 'content-type': 'application/json', 'X-Served-By': `instance ${instance.name}` });
    } catch {
      instance.alive = false; // could not connect: treat as dead and try the next one
    }
  }
  return c.json({ error: { code: 'no_server_available', message: 'No server available right now. Please try again in a few seconds.' } }, 503);
});

instances.forEach(start);
serve({ fetch: app.fetch, port: FRONT_PORT }, () => console.log(`Verifier front door on http://localhost:${FRONT_PORT} with ${COUNT} instances`));

// Stop the instances when the front door stops.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { instances.forEach(kill); process.exit(0); });
