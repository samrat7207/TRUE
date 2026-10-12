// Convergence tests: two verifier instances with separate databases that share state.
// "Killing" an instance here means its link is cut: nothing can reach it and it cannot reach its peer.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ISSUER_ID } from '@true/shared';
import { createHolderProof, createPresentation, generateHolderKey, generateSigningKeyPair } from '@true/credentials';
import { openIssuerDb } from '../services/issuer-api/src/db.ts';
import { createIssuerApp } from '../services/issuer-api/src/app.ts';
import { openVerifierDb } from '../services/verifier-api/src/db.ts';
import { createVerifierApp } from '../services/verifier-api/src/app.ts';
import { mergeState, exportState, type SharedState } from '../services/verifier-api/src/sync.ts';

const KEY = 'test-internal-key';
const json = (body: unknown, headers = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

type App = ReturnType<typeof createVerifierApp>;
let issuer: ReturnType<typeof createIssuerApp>;
let one: App;
let two: App;
let dbOne: ReturnType<typeof openVerifierDb>;
let dbTwo: ReturnType<typeof openVerifierDb>;
let oneAlive: boolean;

beforeEach(async () => {
  const keys = await generateSigningKeyPair();
  issuer = createIssuerApp(openIssuerDb(':memory:'), keys, undefined, { staffAuth: 'off' });
  const lookup = (id: string) => (id === ISSUER_ID ? { publicJwk: keys.publicJwk, state: 'Active' } : null);
  dbOne = openVerifierDb(':memory:');
  dbTwo = openVerifierDb(':memory:');
  oneAlive = true;
  // Each instance pushes to the other through its real /internal/sync endpoint.
  const push = (target: () => App) => async (state: SharedState) => {
    if (!oneAlive) throw new Error('link down');
    const response = await target().request('/internal/sync', json(state, { 'x-internal-key': KEY }));
    if (!response.ok) throw new Error('refused');
  };
  one = createVerifierApp(dbOne, lookup, { instance: '1', internalKey: KEY, sendToPeer: push(() => two) });
  two = createVerifierApp(dbTwo, lookup, { instance: '2', internalKey: KEY, sendToPeer: push(() => one) });
});

async function issueCredential() {
  const holder = await generateHolderKey();
  const { code } = await (await issuer.request('/v1/claim-codes', json({ studentId: 1 }))).json();
  const offer = await (await issuer.request(`/v1/claim-codes/${code}`)).json();
  const proof = await createHolderProof({ holderPrivateKey: holder.privateKey, holderPublicJwk: holder.publicJwk, nonce: offer.nonce, audience: ISSUER_ID });
  const { credential } = await (await issuer.request('/v1/credentials', json({ code, proof }))).json();
  return { holder, credential: credential as string };
}

describe('two verifier instances', () => {
  it('kill instance 1 mid-request: approval through instance 2 is still verified', async () => {
    const { holder, credential } = await issueCredential();
    // Request is created on instance 1...
    const { requestId } = await (await one.request('/v1/requests', json({ verifierId: 'verifier:nova-arena' }))).json();
    // ...then instance 1 dies before the holder answers.
    oneAlive = false;
    // The wallet's calls now land on instance 2, which already knows the request and its nonce.
    const object = await (await two.request(`/v1/requests/${requestId}/object`)).json();
    const presentation = await createPresentation({
      credential, holderPrivateKey: holder.privateKey, claims: object.claims, nonce: object.nonce, audience: object.verifierId,
    });
    const answer = await two.request(`/v1/requests/${requestId}/response`, json({ presentation }));
    expect(answer.status).toBe(200);
    const final = await (await two.request(`/v1/requests/${requestId}`)).json();
    expect(final.state).toBe('verified');
    expect(final.result.claims).toEqual({ age_over_18: true });
  });

  it('a result verified on one instance cannot be replayed on the other', async () => {
    const { holder, credential } = await issueCredential();
    const { requestId } = await (await one.request('/v1/requests', json({ verifierId: 'verifier:nova-arena' }))).json();
    const object = await (await one.request(`/v1/requests/${requestId}/object`)).json();
    const presentation = await createPresentation({
      credential, holderPrivateKey: holder.privateKey, claims: object.claims, nonce: object.nonce, audience: object.verifierId,
    });
    expect((await one.request(`/v1/requests/${requestId}/response`, json({ presentation }))).status).toBe(200);
    expect((await two.request(`/v1/requests/${requestId}/response`, json({ presentation }))).status).toBe(409);
  });

  it('shared data carries no disclosed claims', async () => {
    const { holder, credential } = await issueCredential();
    const { requestId } = await (await one.request('/v1/requests', json({ verifierId: 'verifier:city-library' }))).json();
    const object = await (await one.request(`/v1/requests/${requestId}/object`)).json();
    const presentation = await createPresentation({
      credential, holderPrivateKey: holder.privateKey, claims: object.claims, nonce: object.nonce, audience: object.verifierId,
    });
    await one.request(`/v1/requests/${requestId}/response`, json({ presentation }));
    // Instance 2 knows the outcome but never received the name, photo or PNR.
    const seenByTwo = await (await two.request(`/v1/requests/${requestId}`)).json();
    expect(seenByTwo.state).toBe('verified');
    expect(JSON.stringify(exportState(dbTwo))).not.toContain('Aarav');
    expect(JSON.stringify(exportState(dbOne))).not.toContain('AIT2023001');
  });

  it('a revocation made on one instance appears on the other, and stays after merging older data', async () => {
    const before = exportState(dbTwo); // snapshot with nothing revoked
    await one.request('/internal/status/revoke', json({ index: 5 }, { 'x-internal-key': KEY }));
    expect((await (await two.request('/v1/status/5')).json()).revoked).toBe(true);
    expect((await (await two.request('/v1/status/4')).json()).revoked).toBe(false);
    // Merging an old "not revoked" list must not un-revoke: bitwise OR.
    mergeState(dbTwo, { statusBitsHex: '00' });
    mergeState(dbTwo, before);
    expect((await (await two.request('/v1/status/5')).json()).revoked).toBe(true);
  });

  it('merging the same events twice does not duplicate them', async () => {
    await one.request('/v1/requests', json({ verifierId: 'verifier:nova-arena' }));
    const state = exportState(dbOne);
    const count = () => (dbTwo.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as { n: number }).n;
    const requests = () => (dbTwo.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number }).n;
    expect(count()).toBe(1);
    mergeState(dbTwo, state);
    mergeState(dbTwo, state);
    expect(count()).toBe(1);
    expect(requests()).toBe(1);
  });

  it('three instances: create on 1, kill 1 and 2, approve through 3 is verified', async () => {
    const keys = await generateSigningKeyPair();
    const localIssuer = createIssuerApp(openIssuerDb(':memory:'), keys, undefined, { staffAuth: 'off' });
    const lookup = (id: string) => (id === ISSUER_ID ? { publicJwk: keys.publicJwk, state: 'Active' } : null);
    const apps: App[] = [];
    const alive = [true, true, true];
    // Each instance sends to ALL peers and ignores the ones that are down (same rule as server.ts).
    const fanOut = (self: number) => async (state: SharedState) => {
      if (!alive[self]) throw new Error('down');
      const results = await Promise.allSettled(
        apps.map(async (peer, i) => {
          if (i === self) return;
          if (!alive[i]) throw new Error('down');
          await peer.request('/internal/sync', json(state, { 'x-internal-key': KEY }));
        }),
      );
      if (!results.some((r) => r.status === 'fulfilled')) throw new Error('no peer');
    };
    for (let i = 0; i < 3; i++) {
      apps.push(createVerifierApp(openVerifierDb(':memory:'), lookup, { instance: String(i + 1), internalKey: KEY, sendToPeer: fanOut(i) }));
    }

    const holder = await generateHolderKey();
    const { code } = await (await localIssuer.request('/v1/claim-codes', json({ studentId: 1 }))).json();
    const offer = await (await localIssuer.request(`/v1/claim-codes/${code}`)).json();
    const proof = await createHolderProof({ holderPrivateKey: holder.privateKey, holderPublicJwk: holder.publicJwk, nonce: offer.nonce, audience: ISSUER_ID });
    const { credential } = await (await localIssuer.request('/v1/credentials', json({ code, proof }))).json();

    const { requestId } = await (await apps[0].request('/v1/requests', json({ verifierId: 'verifier:nova-arena' }))).json();
    alive[0] = false;
    alive[1] = false;
    const object = await (await apps[2].request(`/v1/requests/${requestId}/object`)).json();
    const presentation = await createPresentation({
      credential, holderPrivateKey: holder.privateKey, claims: object.claims, nonce: object.nonce, audience: object.verifierId,
    });
    expect((await apps[2].request(`/v1/requests/${requestId}/response`, json({ presentation }))).status).toBe(200);
    expect((await (await apps[2].request(`/v1/requests/${requestId}`)).json()).state).toBe('verified');
  });

  it('kill all, restart one: it recovers from its own database file', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'true-')), 'verifier-1.db');
    let db = openVerifierDb(file);
    let app = createVerifierApp(db, () => null, { instance: '1', internalKey: KEY });
    const { requestId } = await (await app.request('/v1/requests', json({ verifierId: 'verifier:nova-arena' }))).json();
    await app.request('/internal/status/revoke', json({ index: 3 }, { 'x-internal-key': KEY }));
    db.close(); // every instance is dead; nothing is left in memory

    db = openVerifierDb(file); // restart with no live peer
    app = createVerifierApp(db, () => null, { instance: '1', internalKey: KEY });
    expect((await (await app.request(`/v1/requests/${requestId}`)).json()).state).toBe('pending');
    expect((await (await app.request('/v1/status/3')).json()).revoked).toBe(true);
    expect((await (await app.request('/health')).json()).lastSyncedAt).toBe(null);
    db.close();
  });

  it('the sync endpoint refuses callers without the internal key', async () => {
    expect((await one.request('/internal/sync', json({ requests: [] }))).status).toBe(403);
    expect((await one.request('/internal/sync', json({ requests: [] }, { 'x-internal-key': 'wrong' }))).status).toBe(403);
  });
});
