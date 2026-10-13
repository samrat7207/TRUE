// Live event feed: operations routes are for the laptop only, events carry no personal data,
// and the main events have the right severity.
import { describe, expect, it } from 'vitest';
import { answerRequest, loadRequest, setWalletOwner } from '@true/wallet-core';
import type { EventPage, LiveEvent } from '@true/shared';
import { sha256Hex } from '@true/credentials';
import { openVerifierDb } from '../services/verifier-api/src/db.ts';
import { createVerifierApp } from '../services/verifier-api/src/app.ts';
import { createFrontDoor, type Backend } from '../services/verifier-api/src/frontdoor.ts';
import { FIELDS, PASSWORD, json, world } from './helpers.ts';

const LAPTOP = '127.0.0.1';
const PHONE = '192.168.1.7';
const KEY = 'k';

// A front door with the address check switched on, over one in-process instance.
function door() {
  const killed: string[] = [];
  const instance = createVerifierApp(openVerifierDb(':memory:'), () => null, { instance: '1', internalKey: KEY, trustsDeviceHeader: () => true });
  const backends: Backend[] = [{ name: '1', port: 0, alive: true, health: {}, forward: async (path, init) => instance.request(path, init) }];
  const app = createFrontDoor({
    backends, localOnlyOps: true, internalKey: KEY,
    getSource: (c) => c.req.header('x-test-source') ?? 'unknown',
    hashSource: (text) => sha256Hex(text).slice(0, 16),
    getDevice: () => 'abc:android-app',
    controls: { kill: (name) => killed.push(name), restart: () => {} },
    getLanAddresses: () => [{ name: 'Wi-Fi', address: 'http://192.168.1.20' }],
  });
  return { app, backends, killed };
}

// A call as it would arrive from this address, optionally sent by a web page (Origin) or through a forwarder.
const from = (address: string, extra: Record<string, string> = {}, method = 'GET') => ({ method, headers: { 'x-test-source': address, 'content-type': 'application/json', ...extra }, ...(method === 'POST' ? { body: '{}' } : {}) });
const feed = async (app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> }) =>
  ((await (await app.request('/ops/events?limit=1000', from(LAPTOP))).json()) as EventPage).events;
const levelOf = (events: LiveEvent[], code: string) => events.find((event) => event.code === code)?.level;

describe('operations routes are for the laptop only', () => {
  it('front door: a phone on the Wi-Fi, the Android app, a LAN page and a forwarded call all get 403', async () => {
    const { app, killed } = door();
    for (const [method, path] of [['GET', '/ops/events'], ['GET', '/ops/network'], ['GET', '/proxy/status'], ['POST', '/proxy/kill/1'], ['POST', '/proxy/restart/1'], ['POST', '/v1/load-test/cleanup']]) {
      expect((await app.request(path, from(PHONE, {}, method))).status, `${path} from the LAN`).toBe(403);
      expect((await app.request(path, from(LAPTOP, { origin: 'capacitor://localhost' }, method))).status, `${path} from the Android app`).toBe(403);
      expect((await app.request(path, from(LAPTOP, { origin: 'http://192.168.1.20:5176' }, method))).status, `${path} from a LAN page`).toBe(403);
      expect((await app.request(path, from(LAPTOP, { 'x-forwarded-for': PHONE }, method))).status, `${path} forwarded`).toBe(403);
    }
    expect(killed).toEqual([]); // nothing was killed by the refused calls

    // The app opened on the laptop itself is allowed, and only its origin is named in the CORS answer.
    const ok = await app.request('/ops/events', from(LAPTOP, { origin: 'http://localhost:5176' }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:5176');
    expect(await (await app.request('/ops/network', from(LAPTOP))).json()).toEqual({ addresses: [{ name: 'Wi-Fi', address: 'http://192.168.1.20' }] });
    // Normal app traffic from a phone still works.
    expect((await app.request('/v1/requests', { ...from(PHONE, { origin: 'capacitor://localhost' }, 'POST'), body: JSON.stringify({ verifierId: 'verifier:nova-arena' }) })).status).toBe(201);
  });

  it('core API: /ops/* gets 403 from the LAN and from the Android app, 200 from the laptop', async () => {
    const w = await world();
    expect((await w.core.request('/ops/events', from(PHONE))).status).toBe(403);
    expect((await w.core.request('/ops/events', from(LAPTOP, { origin: 'capacitor://localhost' }))).status).toBe(403);
    expect((await w.core.request('/ops/events', from(LAPTOP, { origin: 'http://192.168.1.20:5176' }))).status).toBe(403);
    expect((await w.core.request('/ops/events', from(LAPTOP, { 'x-forwarded-for': PHONE }))).status).toBe(403);
    expect((await w.core.request('/ops/notify/institution-verified', from(PHONE, {}, 'POST'))).status).toBe(403);
    expect((await w.core.request('/ops/events', from(LAPTOP, { origin: 'http://127.0.0.1:5176' }))).status).toBe(200);
  });
});

describe('what the feed says', () => {
  it('core API: severities are right, and no name, email or field value appears', async () => {
    const w = await world();
    const post = (path: string, body: unknown, token?: string) => w.core.request(path, json(body, token));

    await post('/v1/auth/signup', { kind: 'person', name: 'Kabir Shaikh', email: 'kabir@test.true', password: PASSWORD });
    const signup = await (await post('/v1/auth/signup', { kind: 'institution', name: 'Nimbus Labs', email: 'nimbus@test.true', password: PASSWORD, category: 'company' })).json();
    w.coreDb.prepare('UPDATE accounts SET verified = 1 WHERE id = ?').run(signup.account.id);
    expect((await w.core.request('/ops/notify/institution-verified', { ...from(LAPTOP, {}, 'POST'), body: JSON.stringify({ institutionId: signup.account.id }) })).status).toBe(200);
    for (let i = 0; i < 5; i++) await post('/v1/auth/login', { email: 'aarav@test.true', password: 'wrong-password' });

    const astra = await w.login('astra@test.true');
    await post('/v1/institution/lookup', { email: 'nobody@test.true' }, astra.token);
    const issued = await w.issueTo('isha@test.true'); // offer sent, accepted, claimed
    const second = await w.offer(astra.token, 'isha@test.true', 'LibraryCard');
    await post(`/v1/me/offers/${second.id}/reject`, {}, issued.person.token);
    const third = await w.offer(astra.token, 'isha@test.true', 'LibraryCard');
    await post(`/v1/institution/credentials/${third.id}/cancel`, {}, astra.token);
    await post(`/v1/institution/credentials/${issued.id}/revoke`, { reason: 'lost' }, astra.token);
    await post('/v1/auth/delete', { password: PASSWORD }, issued.person.token);

    const events = await feed(w.core);
    const expected: Record<string, string> = {
      signup: 'info', institution_unverified: 'warn', institution_verified: 'success', login_ok: 'info', login_failed: 'warn', login_lockout: 'error',
      lookup_not_found: 'warn', offer_sent: 'info', offer_accepted: 'success', credential_claimed: 'success', offer_declined: 'warn', offer_cancelled: 'warn',
      credential_revoked: 'error', account_deleted: 'warn',
    };
    for (const [code, level] of Object.entries(expected)) expect(levelOf(events, code), code).toBe(level);
    expect(events.every((event) => event.source === 'issuer')).toBe(true);
    expectNoPersonalData(events);
  });

  it('verifier and front door: severities are right, lines name the instance, and nothing personal appears', async () => {
    const w = await world({ instance: '2', internalKey: KEY, trustsDeviceHeader: () => true });
    const backends: Backend[] = [{ name: '2', port: 0, alive: true, health: {}, forward: async (path, init) => w.verifier.request(path, init) }];
    const front = createFrontDoor({
      backends, localOnlyOps: true, internalKey: KEY, getSource: (c) => c.req.header('x-test-source') ?? 'unknown',
      hashSource: (text) => sha256Hex(text).slice(0, 16), getDevice: () => 'abc:android-app', controls: { kill: () => {}, restart: () => {} },
    });
    // The wallet reaches the verifier THROUGH the front door here, like a phone does.
    const viaDoor: typeof w.fetchStub = async (url, init) => {
      const path = new URL(url).pathname + new URL(url).search;
      return url.includes(':4001') ? w.core.request(path, init) : front.request(path, { ...init, headers: { ...(init?.headers as Record<string, string>), 'x-test-source': PHONE } });
    };
    const ask = (path: string, body: unknown, token?: string) => front.request(path, json(body, token, { 'x-test-source': PHONE }));
    const answer = async (requestUri: string, card: Parameters<typeof answerRequest>[0]['stored'], approve = true) => {
      const check = await loadRequest({ requestUri, fetch: viaDoor, getVerifier: (id) => w.verifierRegistry.get(id) ?? null });
      return check.status === 'verified' ? answerRequest({ check, stored: card, approve, fetch: viaDoor }) : null;
    };

    const { card, person, institution, id } = await w.issueTo('aarav@test.true');
    const owner = await w.login('isha@test.true');
    const register = (await (await ask('/v1/registers', { name: 'Hostel gate', purpose: 'Entry to the hostel', issuerId: institution.id, issuerName: 'Astra Institute of Technology', type: 'StudentID', fields: ['name', 'blood_group'] }, owner.token)).json()).register;
    setWalletOwner(person.id);

    const first = await (await ask(`/v1/registers/${register.id}/requests`, {}, owner.token)).json();
    expect(await answer(first.requestUri, card)).toMatchObject({ state: 'verified' });
    expect((await ask(`/v1/registers/${register.id}/requests`, { claims: ['name', 'address'] }, owner.token)).status).toBe(400); // over-ask refused
    const declined = await (await ask(`/v1/registers/${register.id}/requests`, {}, owner.token)).json();
    await answer(declined.requestUri, card, false);

    // Revoked: the same card is now denied.
    await w.core.request(`/v1/institution/credentials/${id}/revoke`, json({ reason: 'lost' }, institution.token));
    await w.refreshRevocations();
    const again = await (await ask(`/v1/registers/${register.id}/requests`, {}, owner.token)).json();
    expect(await answer(again.requestUri, card)).toMatchObject({ state: 'denied', code: 'revoked' });

    await ask('/v1/requests', { verifierId: 'verifier:free-prize-booth' }); // the phishing demo
    await ask('/v1/requests', { verifierId: 'verifier:campus-store', claims: ['name', 'address'] }); // the over-ask demo
    await ask(`/v1/registers/${register.id}/delete`, {}, owner.token);
    await front.request('/proxy/kill/2', from(LAPTOP, {}, 'POST'));
    await front.request('/proxy/restart/2', from(LAPTOP, {}, 'POST'));
    await front.request('/v1/requests', { ...from(LAPTOP, {}, 'POST'), body: JSON.stringify({ verifierId: 'verifier:load-test' }) });
    await front.request('/v1/requests', { ...from(LAPTOP, {}, 'POST'), body: JSON.stringify({ verifierId: 'verifier:load-test' }) });
    await front.request('/v1/load-test/cleanup', { ...from(LAPTOP, {}, 'POST'), body: JSON.stringify({ requests: 2, failures: 0 }) });
    backends[0].alive = false; // every instance down
    expect((await ask('/v1/requests', { verifierId: 'verifier:nova-arena' })).status).toBe(503);
    backends[0].alive = true;
    expect((await ask('/v1/requests', { verifierId: 'verifier:nova-arena' })).status).toBe(201);

    const events = await feed(front);
    const expected: Record<string, string> = {
      register_created: 'info', request_created: 'info', verified: 'success', beyond_register: 'warn', user_declined: 'warn', revoked: 'error',
      unregistered_verifier: 'warn', over_ask: 'warn', register_deleted: 'warn', instance_killed: 'error', instance_restarted: 'success',
      loadtest_started: 'info', loadtest_finished: 'success', no_server_available: 'error', recovered: 'success',
    };
    for (const [code, level] of Object.entries(expected)) expect(levelOf(events, code), code).toBe(level);

    const verified = events.find((event) => event.code === 'verified')!;
    expect(verified).toMatchObject({ source: 'verifier-2', device: 'abc:android-app' });
    expect(verified.message).toBe('Verified at register "Hostel gate" · served by instance 2');
    // The load test is ONE start line and ONE summary, not a line per synthetic request.
    expect(events.filter((event) => event.code.startsWith('loadtest'))).toHaveLength(2);
    expect(events.filter((event) => event.message.includes('Load test (synthetic)'))).toHaveLength(0);
    // Reading the feed twice does not copy the instance's events twice, and "after" returns only newer ones.
    expect(await feed(front)).toHaveLength(events.length);
    const newer = (await (await front.request(`/ops/events?after=${events.at(-1)!.seq}`, from(LAPTOP))).json()) as EventPage;
    expect(newer.events).toEqual([]);
    expectNoPersonalData(events);
  });

  it('an instance believes the device header only when the call comes from the front door', async () => {
    const untrusting = createVerifierApp(openVerifierDb(':memory:'), () => null, { instance: '1', internalKey: KEY, trustsDeviceHeader: () => false });
    await untrusting.request('/v1/requests', json({ verifierId: 'verifier:nova-arena' }, undefined, { 'x-device': 'fff:android-app' }));
    const page = (await (await untrusting.request('/internal/events', { headers: { 'x-internal-key': KEY } })).json()) as EventPage;
    expect(page.events[0]).toMatchObject({ code: 'request_created', device: null });
    expect((await untrusting.request('/internal/events')).status).toBe(403); // no shared secret, no events
  });
});

// No person's name, no email address, no field value, no IP address. (Institution and register names are allowed.)
function expectNoPersonalData(events: LiveEvent[]) {
  const text = JSON.stringify(events);
  const forbidden = ['Aarav', 'Deshmukh', 'Isha', 'Kulkarni', 'Kabir', 'Shaikh', '@', PHONE, LAPTOP,
    ...Object.values(FIELDS).flatMap((fields) => Object.values(fields)).filter((value) => value.length >= 5)];
  for (const word of forbidden) expect(text, `the feed must not contain "${word}"`).not.toContain(word);
}
