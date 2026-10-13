// Front door on port 4000. The wallet and the verifier screen talk ONLY to this.
// This file does the "real world" part: it starts the verifier instances as processes, checks their
// health every 2 seconds, and gives the front door logic (frontdoor.ts) a way to reach each one.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { randomToken, sha256Hex } from '@true/credentials';
import { createEventLog, deviceLabel } from '@true/shared';
import { createFrontDoor, DEFAULT_LIMITS, type Backend } from './frontdoor.ts';

// Settings come from .env. If there is no .env we make a random internal key for this run,
// so "npm run dev" still works on a fresh checkout.
const ENV_FILE = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const INTERNAL_KEY = process.env.INTERNAL_SYNC_KEY || randomToken();
const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

// How many instances to run (default 3). Instance N listens on 4002, 4012, 4022, ... and uses verifier-N.db.
// FRONT_DOOR_PORT and INSTANCE_BASE_PORT exist only so a test run can use spare ports.
const COUNT = env('VERIFIER_INSTANCES', 3);
const FRONT_PORT = env('FRONT_DOOR_PORT', 4000);
const BASE_PORT = env('INSTANCE_BASE_PORT', 4002);

// Salt for the short device labels in the live event feed. "npm run dev" writes a fresh one on every start,
// and both services read the same file, so one phone gets the same label everywhere during a run.
const SALT_FILE = new URL('../../../data/run-salt.txt', import.meta.url);
if (!existsSync(SALT_FILE)) writeFileSync(SALT_FILE, crypto.randomUUID());
const RUN_SALT = readFileSync(SALT_FILE, 'utf8');

// The live event feed. The front door logic writes most lines; the health check below adds "stopped" and "alive".
const events = createEventLog('front-door');

const children = new Map<string, ChildProcess>();
const urlOf = (backend: { port: number }) => `http://127.0.0.1:${backend.port}`;

const backends: Backend[] = Array.from({ length: COUNT }, (_, i) => {
  const port = BASE_PORT + i * 10;
  return {
    name: String(i + 1),
    port,
    alive: false,
    health: {},
    forward: (path, init) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, signal: AbortSignal.timeout(5000) }),
  };
});

function start(name: string) {
  const backend = backends.find((b) => b.name === name);
  if (!backend || children.has(name)) return;
  const peers = backends.filter((other) => other !== backend).map(urlOf).join(',');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.ts', import.meta.url))], {
    env: { ...process.env, INSTANCE: name, PORT: String(backend.port), PEER_URLS: peers, INTERNAL_SYNC_KEY: INTERNAL_KEY },
    stdio: 'inherit',
  });
  child.on('exit', () => { children.delete(name); backend.alive = false; });
  children.set(name, child);
}

function kill(name: string) {
  children.get(name)?.kill();
  const backend = backends.find((b) => b.name === name);
  if (backend) backend.alive = false;
}

// Health check: every 2 seconds ask each instance if it is alive, when it last synced, and for its counters.
// A dead instance that comes back is noticed here, so the front door recovers on its own.
setInterval(() => {
  for (const backend of backends) {
    fetch(urlOf(backend) + '/health', { signal: AbortSignal.timeout(1000) })
      .then((response) => response.json())
      .then((health) => {
        if (!backend.alive) events.emit('success', 'instance_up', `Instance ${backend.name} is alive`);
        backend.alive = true;
        backend.health = health;
      })
      .catch(() => {
        // Alive a moment ago and nobody pressed Kill (Kill marks it dead itself): it stopped on its own.
        if (backend.alive) events.emit('error', 'instance_down', `Instance ${backend.name} stopped responding`);
        backend.alive = false;
      });
  }
}, 2000);

const app = createFrontDoor({
  backends,
  limits: {
    failMax: env('RATE_FAIL_MAX', DEFAULT_LIMITS.failMax),
    failWindowSeconds: env('RATE_FAIL_WINDOW_SECONDS', DEFAULT_LIMITS.failWindowSeconds),
    blockSeconds: env('RATE_BLOCK_SECONDS', DEFAULT_LIMITS.blockSeconds),
    createMax: env('RATE_CREATE_MAX_PER_MINUTE', DEFAULT_LIMITS.createMax),
  },
  getSource: (c) => getConnInfo(c).remote.address ?? 'unknown',
  // Salted with our internal key, so the short hash cannot be matched back to an IP address by guessing.
  hashSource: (text) => sha256Hex(INTERNAL_KEY + text).slice(0, 16),
  controls: { kill, restart: start },
  localOnlyOps: true,
  events,
  internalKey: INTERNAL_KEY,
  // Only this short salted hash and a coarse device class are kept: never the address or the full User-Agent.
  getDevice: (c) => deviceLabel(getConnInfo(c).remote.address ?? 'unknown', c.req.header('user-agent') ?? '', (text) => sha256Hex(RUN_SALT + text)),
  // This machine's IPv4 addresses on the local network (not 127.0.0.1): what a phone types as "Server address".
  // The Wi-Fi adapter is listed first: a laptop often has other adapters (virtual machines) that phones cannot reach.
  getLanAddresses: () => Object.entries(networkInterfaces())
    .flatMap(([name, list]) => (list ?? []).filter((item) => item.family === 'IPv4' && !item.internal).map((item) => ({ name, address: `http://${item.address}` })))
    .sort((a, b) => Number(/wi-?fi|wlan|wireless/i.test(b.name)) - Number(/wi-?fi|wlan|wireless/i.test(a.name))),
  // Write the block into the audit log of any alive instance; it shares it with the others.
  onBlock: (event) => {
    const backend = backends.find((b) => b.alive);
    backend?.forward('/internal/audit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': INTERNAL_KEY },
      body: JSON.stringify({ type: 'source.blocked', subject: `source:${event.source}` }),
    }).catch(() => {});
  },
});

backends.forEach((backend) => start(backend.name));

// Development convenience: when the verifier's code (or a shared package) changes on disk, restart the instances
// so they never keep serving old code. Their data is in their database files, so nothing is lost.
// (This file itself is not reloaded: after changing proxy.ts or frontdoor.ts, restart "npm run dev".)
let restartTimer: ReturnType<typeof setTimeout> | undefined;
function restartInstancesSoon(changed: string | null) {
  if (changed && !/\.(ts|json)$/.test(changed)) return; // ignore database files and editor temp files
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    console.log('Code changed: restarting the verifier instances');
    for (const backend of backends) {
      const child = children.get(backend.name);
      if (!child) { start(backend.name); continue; }
      child.once('exit', () => start(backend.name));
      kill(backend.name);
    }
  }, 500);
}
for (const folder of ['./', '../../../packages/']) {
  watch(fileURLToPath(new URL(folder, import.meta.url)), { recursive: true }, (_event, file) => restartInstancesSoon(file));
}
serve({ fetch: app.fetch, port: FRONT_PORT }, () => console.log(`Verifier front door on http://localhost:${FRONT_PORT} with ${COUNT} instances`));

// Stop the instances when the front door stops.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { backends.forEach((b) => kill(b.name)); process.exit(0); });
