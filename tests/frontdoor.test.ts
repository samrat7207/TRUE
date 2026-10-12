// Front door tests: rate limiting, with in-process verifier instances and a clock we can move.
import { describe, expect, it } from 'vitest';
import { runLoadTest } from '@true/shared';
import { sha256Hex } from '@true/credentials';
import { openVerifierDb } from '../services/verifier-api/src/db.ts';
import { createVerifierApp } from '../services/verifier-api/src/app.ts';
import { createFrontDoor, DEFAULT_LIMITS, type Backend, type BlockEvent, type Limits } from '../services/verifier-api/src/frontdoor.ts';

const json = (body: unknown, source = 'alice') => ({ method: 'POST', headers: { 'content-type': 'application/json', 'x-test-source': source }, body: JSON.stringify(body) });

// A front door over `count` in-process instances. The caller's "IP address" is the x-test-source header.
export function setup(count = 1, limits: Limits = DEFAULT_LIMITS) {
  let time = 1_000_000;
  const blocks: BlockEvent[] = [];
  const backends: Backend[] = Array.from({ length: count }, (_, i) => {
    const app = createVerifierApp(openVerifierDb(':memory:'), () => null, { instance: String(i + 1) });
    return { name: String(i + 1), port: 0, alive: true, health: {}, forward: async (path, init) => app.request(path, init) };
  });
  const door = createFrontDoor({
    backends,
    limits,
    now: () => time,
    getSource: (c) => c.req.header('x-test-source') ?? 'unknown',
    hashSource: (text) => sha256Hex(text).slice(0, 16),
    onBlock: (event) => blocks.push(event),
  });
  return { door, backends, blocks, advance: (seconds: number) => { time += seconds * 1000; } };
}

type Door = ReturnType<typeof setup>['door'];

// One failed verification attempt: a new request answered with rubbish instead of a real presentation.
async function failedAttempt(door: Door, source: string, verifierId = 'verifier:nova-arena') {
  const { requestId } = await (await door.request('/v1/requests', json({ verifierId }, source))).json();
  return door.request(`/v1/requests/${requestId}/response`, json({ presentation: 'not-a-real-presentation' }, source));
}

describe('rate limiting', () => {
  it('6 failed attempts: the first 5 are answered, the 6th is blocked with 429 and Retry-After', async () => {
    const { door, blocks } = setup();
    for (let i = 0; i < 5; i++) expect((await failedAttempt(door, 'mallory')).status).toBe(200);

    const sixth = await failedAttempt(door, 'mallory');
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get('Retry-After')).toBe('60');
    const body = await sixth.json();
    expect(body.error.code).toBe('too_many_attempts');
    expect(body.error.message).toBe('Too many attempts, try again in 60 seconds');

    // The block was reported once, with a hashed source: no IP address, no personal data.
    expect(blocks).toHaveLength(1);
    expect(blocks[0].source).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(blocks[0])).not.toContain('mallory');
    const status = await (await door.request('/proxy/status')).json();
    expect(status.blocked.active).toBe(1);
    expect(status.blocked.recent[0].verifierId).toBe('verifier:nova-arena');
  });

  it('a normal user is not affected by someone else being blocked', async () => {
    const { door } = setup();
    for (let i = 0; i < 6; i++) await failedAttempt(door, 'mallory');
    // Another source, same verifier: fine. Same source, another verifier: also fine (blocks are per source + verifier).
    expect((await failedAttempt(door, 'alice')).status).toBe(200);
    expect((await failedAttempt(door, 'mallory', 'verifier:campus-store')).status).toBe(200);
  });

  it('declining is not a failure, and a few mistakes do not block', async () => {
    const { door } = setup();
    for (let i = 0; i < 8; i++) {
      const { requestId } = await (await door.request('/v1/requests', json({ verifierId: 'verifier:nova-arena' }))).json();
      expect((await door.request(`/v1/requests/${requestId}/response`, json({ declined: true }))).status).toBe(200);
    }
    for (let i = 0; i < 4; i++) expect((await failedAttempt(door, 'alice')).status).toBe(200);
    expect((await failedAttempt(door, 'alice')).status).toBe(200); // 5th failure is still answered
  });

  it('the block expires', async () => {
    const { door, advance } = setup();
    for (let i = 0; i < 5; i++) await failedAttempt(door, 'mallory');
    expect((await failedAttempt(door, 'mallory')).status).toBe(429);
    advance(30);
    const half = await failedAttempt(door, 'mallory');
    expect(half.status).toBe(429);
    expect(half.headers.get('Retry-After')).toBe('30');
    advance(31);
    expect((await failedAttempt(door, 'mallory')).status).toBe(200);
  });

  it('old failures fall out of the window', async () => {
    const { door, advance } = setup();
    for (let i = 0; i < 4; i++) await failedAttempt(door, 'bob');
    advance(61); // those 4 are now older than the 60 second window
    for (let i = 0; i < 4; i++) expect((await failedAttempt(door, 'bob')).status).toBe(200);
  });

  it('request creation has its own generous limit per source', async () => {
    const { door, advance } = setup(1, { ...DEFAULT_LIMITS, createMax: 3 });
    const create = (source: string) => door.request('/v1/requests', json({ verifierId: 'verifier:nova-arena' }, source));
    for (let i = 0; i < 3; i++) expect((await create('kiosk')).status).toBe(201);
    const fourth = await create('kiosk');
    expect(fourth.status).toBe(429);
    expect((await fourth.json()).error.code).toBe('too_many_requests');
    expect((await create('other-kiosk')).status).toBe(201);
    advance(61);
    expect((await create('kiosk')).status).toBe(201);
  });
});

describe('load test', () => {
  // Three instances that share state with each other, like the real ones.
  function cluster(limits: Limits = DEFAULT_LIMITS) {
    const apps: ReturnType<typeof createVerifierApp>[] = [];
    const dbs = [0, 1, 2].map(() => openVerifierDb(':memory:'));
    const dead = new Set<number>();
    dbs.forEach((db, self) => {
      apps.push(createVerifierApp(db, () => null, {
        instance: String(self + 1),
        internalKey: 'k',
        sendToPeer: async (state) => {
          await Promise.all(apps.map(async (peer, i) => {
            if (i !== self && !dead.has(i)) await peer.request('/internal/sync', { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-key': 'k' }, body: JSON.stringify(state) });
          }));
        },
      }));
    });
    const backends: Backend[] = apps.map((app, i) => ({
      name: String(i + 1), port: 0, alive: true, health: {},
      forward: async (path, init) => { if (dead.has(i)) throw new Error('connection refused'); return app.request(path, init); },
    }));
    const door = createFrontDoor({ backends, limits, getSource: () => 'kiosk', hashSource: (text) => sha256Hex(text).slice(0, 16) });
    const call = async (path: string, init?: RequestInit) => door.request(path, init);
    const count = (db: (typeof dbs)[number], table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    return { door, dbs, call, count, kill: (i: number) => dead.add(i) };
  }

  it('spreads the calls across all alive instances with no failures', async () => {
    const { call } = cluster();
    const stats = await runLoadTest(call, () => {});
    expect(stats.failures).toBe(0);
    expect(stats.calls).toBe(100);
    expect(Object.keys(stats.perInstance).sort()).toEqual(['instance 1', 'instance 2', 'instance 3']);
    for (const served of Object.values(stats.perInstance)) expect(served).toBeGreaterThan(20);
  });

  it('killing an instance mid-test does not make requests fail', async () => {
    const { call, kill } = cluster();
    let killed = false;
    const stats = await runLoadTest(call, (progress) => {
      if (!killed && progress.calls >= 30) { killed = true; kill(0); } // instance 1 dies after 30 calls
    });
    expect(killed).toBe(true);
    expect(stats.failures).toBe(0);
    expect(stats.calls).toBe(100);
    // The two survivors took over the rest of the load.
    expect(stats.perInstance['instance 2'] + stats.perInstance['instance 3']).toBeGreaterThan(65);
  });

  it('the status panel reports a dead instance as dead even if its last health answer said alive', async () => {
    const { door, backends } = setup(2);
    backends[0].health = { alive: true, served: 4 };
    backends[0].alive = false;
    const status = await (await door.request('/proxy/status')).json();
    expect(status.instances[0]).toMatchObject({ name: '1', alive: false, served: 4 });
    expect(status.instances[1].alive).toBe(true);
  });

  it('uses its own limit bucket, leaves one audit line, and cleans up everywhere', async () => {
    // Normal creation limit is tiny here; the load test must neither hit it nor use it up.
    const { call, door, dbs, count } = cluster({ ...DEFAULT_LIMITS, createMax: 2 });
    const stats = await runLoadTest(call, () => {});
    expect(stats.failures).toBe(0);
    expect((await door.request('/v1/requests', json({ verifierId: 'verifier:nova-arena' }))).status).toBe(201);

    for (const db of dbs) {
      // Only the one real request above is left, and the audit log has the summary line plus that request.
      expect(count(db, 'requests')).toBe(1);
      const events = db.prepare('SELECT type, request_id FROM audit_events ORDER BY type').all() as { type: string; request_id: string }[];
      expect(events.map((e) => e.type)).toEqual(['loadtest.summary', 'request.created']);
      expect(events[0].request_id).toBe('load-test: 50 requests, 0 failures');
    }
    // The synthetic verifier is not offered as a normal verifier.
    const list = await (await door.request('/v1/verifiers')).json();
    expect(list.verifiers.map((v: { id: string }) => v.id)).not.toContain('verifier:load-test');
  });
});
