// A register's visitor list.
import { beforeEach, describe, expect, it } from 'vitest';
import { answerRequest, loadRequest, type StoredCredential } from '@true/wallet-core';
import { openVerifierDb } from '../services/verifier-api/src/db.ts';
import { createVerifierApp } from '../services/verifier-api/src/app.ts';
import { mergeState, type SharedState } from '../services/verifier-api/src/sync.ts';
import { auth, json, world } from './helpers.ts';

let w: Awaited<ReturnType<typeof world>>;
let owner: string; // Isha's token: she owns the register
let registerId: string;
const shared: SharedState[] = []; // everything instance 1 sent to its peers

beforeEach(async () => {
  shared.length = 0;
  w = await world({ instance: '1', sendToPeer: async (state) => { shared.push(structuredClone(state)); } });
  owner = (await w.login('isha@test.true')).token;
  const astra = await w.login('astra@test.true');
  const created = await w.verifier.request('/v1/registers', json({
    name: 'Hostel gate', purpose: 'Entry to the hostel', issuerId: astra.id, issuerName: 'Astra Institute of Technology', type: 'StudentID', fields: ['name', 'blood_group'],
  }, owner));
  registerId = (await created.json()).register.id;
});

async function check(card: StoredCredential) {
  const { requestUri } = await (await w.verifier.request(`/v1/registers/${registerId}/requests`, json({}, owner))).json();
  const request = await loadRequest({ requestUri, fetch: w.fetchStub, getVerifier: (id) => w.verifierRegistry.get(id) ?? null });
  if (request.status !== 'verified') throw new Error('request not authenticated');
  return answerRequest({ check: request, stored: card, approve: true, fetch: w.fetchStub });
}
const visits = async (token = owner, app = w.verifier) => app.request(`/v1/registers/${registerId}/visits`, auth(token));

describe('visitor list', () => {
  it('the owner sees visits with only the requested fields; a non-owner gets 403', async () => {
    const { card } = await w.issueTo('aarav@test.true');
    expect((await check(card)).state).toBe('verified');
    expect((await check(card)).state).toBe('verified');

    const list = await (await visits()).json();
    expect(list.visitors).toHaveLength(1); // grouped by credential
    expect(list.visitors[0]).toMatchObject({ name: 'Aarav Deshmukh', visits: 2, status: 'valid', type: 'StudentID', issuerName: 'Astra Institute of Technology' });
    expect(list.visitors[0].fields).toEqual({ name: 'Aarav Deshmukh', blood_group: 'B+' }); // nothing the register did not ask for
    expect(JSON.stringify(list)).not.toContain('Lake View');
    expect(list.retentionDays).toBe(30);

    const stranger = (await w.login('aarav@test.true')).token;
    expect((await visits(stranger)).status).toBe(403);
    expect((await w.verifier.request(`/v1/registers/${registerId}/visits`)).status).toBe(401);
  });

  it('revoking the credential flips its status in the list, and the visit stays', async () => {
    const { id, card, institution } = await w.issueTo('aarav@test.true');
    await check(card);
    expect((await (await visits()).json()).visitors[0].status).toBe('valid');
    await w.core.request(`/v1/institution/credentials/${id}/revoke`, json({ reason: 'lost' }, institution.token));
    await w.refreshRevocations(); // the verifier's next scheduled refresh
    const after = (await (await visits()).json()).visitors;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ status: 'revoked', visits: 1 });
    // A compromised issuer key shows too.
    const other = await w.issueTo('isha@test.true');
    await check(other.card);
    w.chainState.keys.get(`${other.institution.id}/key-1`)!.state = 'Compromised';
    expect((await (await visits()).json()).visitors.map((v: { status: string }) => v.status).sort()).toEqual(['key_compromised', 'revoked']);
  });

  it('a visit survives killing the instance that recorded it (it was replicated)', async () => {
    const { card } = await w.issueTo('aarav@test.true');
    await check(card);
    // Instance 2 has its own empty database and only ever receives what instance 1 sent to its peers.
    const dbTwo = openVerifierDb(':memory:');
    for (const state of shared) mergeState(dbTwo, state);
    for (const state of shared) mergeState(dbTwo, state); // receiving it twice must not duplicate
    const two = createVerifierApp(dbTwo, w.getIssuerKey, { instance: '2', getSessionKey: () => w.sessionPublicJwk });
    // Instance 1 is now "dead": we only ask instance 2.
    const list = await (await visits(owner, two)).json();
    expect(list.visitors).toHaveLength(1);
    expect(list.visitors[0]).toMatchObject({ name: 'Aarav Deshmukh', visits: 1, servedBy: ['1'], fields: { name: 'Aarav Deshmukh', blood_group: 'B+' } });
  });

  it('deleting a register deletes its visits, here and on the other instances', async () => {
    const { card } = await w.issueTo('aarav@test.true');
    await check(card);
    const dbTwo = openVerifierDb(':memory:');
    for (const state of shared) mergeState(dbTwo, state);
    const count = (db: typeof dbTwo) => (db.prepare('SELECT COUNT(*) AS n FROM visits').get() as { n: number }).n;
    expect([count(w.verifierDb), count(dbTwo)]).toEqual([1, 1]);

    await w.verifier.request(`/v1/registers/${registerId}/delete`, json({}, owner));
    for (const state of shared) mergeState(dbTwo, state); // the deletion reaches instance 2
    expect([count(w.verifierDb), count(dbTwo)]).toEqual([0, 0]);
    expect((await visits()).status).toBe(404);
  });

  it('denied attempts store no details: only a count per reason', async () => {
    const wrong = await w.issueTo('aarav@test.true', 'gym@test.true', 'StudentID'); // right type, wrong institution
    expect((await check(wrong.card)).code).toBe('wrong_issuer');
    expect((await check(wrong.card)).code).toBe('wrong_issuer');
    const list = await (await visits()).json();
    expect(list.visitors).toEqual([]);
    expect(list.denied).toEqual({ total: 2, byReason: { wrong_issuer: 2 } });
    const stored = JSON.stringify([w.verifierDb.prepare('SELECT * FROM register_denials').all(), w.verifierDb.prepare('SELECT * FROM visits').all()]);
    for (const personal of ['Aarav', 'B+', 'AIT2023001', wrong.institution.id]) expect(stored).not.toContain(personal);
  });
});

describe('through the front door', () => {
  it('a verification via a register creates a visit the owner can list, with live status', async () => {
    const { createFrontDoor } = await import('../services/verifier-api/src/frontdoor.ts');
    const { URLS } = await import('@true/shared');
    const { sha256Hex } = await import('@true/credentials');
    // The front door over our one instance, exactly as the app reaches it: only content-type and the session token get through.
    const door = createFrontDoor({
      backends: [{ name: '1', port: 0, alive: true, health: {}, forward: async (path, init) => w.verifier.request(path, init) }],
      getSource: () => 'phone', hashSource: (text) => sha256Hex(text).slice(0, 16),
    });
    const viaDoor = async (url: string, init?: object) => {
      const { pathname, search } = new URL(url);
      return url.startsWith(URLS.coreApi) ? w.core.request(pathname + search, init) : door.request(pathname + search, init);
    };

    const { id, card, institution } = await w.issueTo('aarav@test.true');
    const created = await door.request(`/v1/registers/${registerId}/requests`, json({}, owner));
    expect(created.status).toBe(201);
    const { requestUri } = await created.json();
    const request = await loadRequest({ requestUri, fetch: viaDoor, getVerifier: (verifierId) => w.verifierRegistry.get(verifierId) ?? null });
    if (request.status !== 'verified') throw new Error('request not authenticated');
    expect((await answerRequest({ check: request, stored: card, approve: true, fetch: viaDoor })).state).toBe('verified');

    const listed = await door.request(`/v1/registers/${registerId}/visits`, auth(owner));
    expect(listed.status).toBe(200);
    expect(listed.headers.get('X-Served-By')).toBe('instance 1');
    const list = await listed.json();
    expect(list.visitors).toHaveLength(1);
    expect(list.visitors[0]).toMatchObject({ name: 'Aarav Deshmukh', visits: 1, status: 'valid', fields: { name: 'Aarav Deshmukh', blood_group: 'B+' } });

    // Live status: after the institution revokes and the verifier refreshes, the same visit reads Revoked.
    await w.core.request(`/v1/institution/credentials/${id}/revoke`, json({ reason: 'lost' }, institution.token));
    await w.refreshRevocations();
    expect((await (await door.request(`/v1/registers/${registerId}/visits`, auth(owner))).json()).visitors[0].status).toBe('revoked');

    // No token, and an address the server does not have, both come back as readable JSON errors (never plain text).
    expect((await door.request(`/v1/registers/${registerId}/visits`)).status).toBe(401);
    const unknown = await door.request('/v1/registers/x/no-such-thing', auth(owner));
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.code).toBe('unknown_route');
  });
});
