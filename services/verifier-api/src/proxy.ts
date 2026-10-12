// Front door on port 4000. The wallet and the verifier screen talk ONLY to this.
// It starts the two verifier instances, checks their health every 2 seconds,
// and forwards each request to an instance that is alive.
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

// Ports: front door 4000, instances 4002 and 4012. Overridable only so a test run can use spare ports.
const FRONT_PORT = Number(process.env.FRONT_DOOR_PORT ?? 4000);
const [PORT_1, PORT_2] = (process.env.INSTANCE_PORTS ?? '4002,4012').split(',').map(Number);

type Instance = { name: string; port: number; peerPort: number; alive: boolean; lastSyncedAt: number | null; child: ChildProcess | null };
const instances: Instance[] = [
  { name: '1', port: PORT_1, peerPort: PORT_2, alive: false, lastSyncedAt: null, child: null },
  { name: '2', port: PORT_2, peerPort: PORT_1, alive: false, lastSyncedAt: null, child: null },
];
const urlOf = (instance: Instance) => `http://localhost:${instance.port}`;

function start(instance: Instance) {
  if (instance.child) return;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.ts', import.meta.url))], {
    env: { ...process.env, INSTANCE: instance.name, PORT: String(instance.port), PEER_URL: `http://localhost:${instance.peerPort}`, INTERNAL_SYNC_KEY: INTERNAL_KEY },
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
async function checkHealth() {
  for (const instance of instances) {
    try {
      const body = await (await fetch(urlOf(instance) + '/health', { signal: AbortSignal.timeout(1000) })).json();
      instance.alive = true;
      instance.lastSyncedAt = body.lastSyncedAt;
    } catch {
      instance.alive = false;
    }
  }
}
setInterval(checkHealth, 2000);

const app = new Hono();
app.use('*', cors());

// Status panel data for the verifier screen.
app.get('/proxy/status', (c) =>
  c.json({ instances: instances.map((i) => ({ name: i.name, port: i.port, alive: i.alive, lastSyncedAt: i.lastSyncedAt })), now: Date.now() }),
);

// Demo buttons: stop or start one instance.
app.post('/proxy/kill/:name', (c) => {
  const instance = instances.find((i) => i.name === c.req.param('name'));
  if (instance) kill(instance);
  return c.json({ ok: true });
});
app.post('/proxy/restart/:name', (c) => {
  const instance = instances.find((i) => i.name === c.req.param('name'));
  if (instance) start(instance);
  return c.json({ ok: true });
});

// The internal sync endpoints are never reachable through the front door.
app.all('/internal/*', (c) => c.json({ error: { code: 'forbidden', message: 'Not available here' } }, 403));

// Everything else: forward to an alive instance. If that one has just died, try the other.
app.all('*', async (c) => {
  const url = new URL(c.req.url);
  const body = ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.text();
  const order = [...instances].sort((a, b) => Number(b.alive) - Number(a.alive));
  for (const instance of order) {
    try {
      const response = await fetch(urlOf(instance) + url.pathname + url.search, {
        method: c.req.method,
        headers: { 'content-type': c.req.header('content-type') ?? 'application/json' },
        body,
        signal: AbortSignal.timeout(5000),
      });
      return c.body(await response.text(), response.status as 200, { 'content-type': 'application/json', 'x-served-by': `instance-${instance.name}` });
    } catch {
      instance.alive = false; // could not connect: treat as dead and try the next one
    }
  }
  return c.json({ error: { code: 'no_instance_alive', message: 'Both verifier instances are down' } }, 503);
});

instances.forEach(start);
serve({ fetch: app.fetch, port: FRONT_PORT }, () => console.log(`Verifier front door listening on http://localhost:${FRONT_PORT}`));

// Stop the instances when the front door stops.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { instances.forEach(kill); process.exit(0); });
