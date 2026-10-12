// Front door tests: rate limiting, with in-process verifier instances and a clock we can move.
import { describe, expect, it } from 'vitest';
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
