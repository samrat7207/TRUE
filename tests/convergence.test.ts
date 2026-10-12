// Convergence tests: two verifier instances with separate databases that share state.
// "Killing" an instance here means its link is cut: nothing can reach it and it cannot reach its peer.
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
  issuer = createIssuerApp(openIssuerDb(':memory:'), keys);
  const lookup = (id: string) => (id === ISSUER_ID ? keys.publicJwk : null);
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

  it('the sync endpoint refuses callers without the internal key', async () => {
    expect((await one.request('/internal/sync', json({ requests: [] }))).status).toBe(403);
    expect((await one.request('/internal/sync', json({ requests: [] }, { 'x-internal-key': 'wrong' }))).status).toBe(403);
  });
});
