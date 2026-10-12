// Holder "Requests" tab: ask the issuer for a credential, staff approve or reject, the wallet collects it by itself.
import { beforeEach, describe, expect, it } from 'vitest';
import { ISSUER_ID } from '@true/shared';
import { createPresentation, generateSigningKeyPair, readCredential } from '@true/credentials';
import {
  getCredentials, getHolderKey, getMyRequests, refreshCredentialRequests, resetWallet, submitCredentialRequest, useMemoryStorage, type Fetch,
} from '@true/wallet-core';
import { openIssuerDb } from '../services/issuer-api/src/db.ts';
import { createIssuerApp } from '../services/issuer-api/src/app.ts';
import { openVerifierDb } from '../services/verifier-api/src/db.ts';
import { createVerifierApp } from '../services/verifier-api/src/app.ts';

const ISSUER_API = 'http://localhost:4001';
const STAFF = [
  { id: 'S-002', name: 'Test Issuer', role: 'issuer' as const, pin: '2222' },
  { id: 'S-003', name: 'Test Revoker', role: 'revoker' as const, pin: '3333' },
];

let issuer: ReturnType<typeof createIssuerApp>;
let issuerDb: ReturnType<typeof openIssuerDb>;
let verifier: ReturnType<typeof createVerifierApp>;
let fetchStub: Fetch;

const json = (body: unknown, token?: string) => ({
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
});
const signIn = async (staffId: string, pin: string) => (await (await issuer.request('/v1/staff/login', json({ staffId, pin }))).json()).token as string;
const inbox = async (token: string) => (await issuer.request('/v1/requests-inbox', { headers: { authorization: `Bearer ${token}` } })).json();
const ask = (pnr: string, dob: string, type = 'StudentCredential') => submitCredentialRequest({ type, pnr, dob, issuerApi: ISSUER_API, fetch: fetchStub });
const refresh = () => refreshCredentialRequests({ issuerApi: ISSUER_API, fetch: fetchStub });

beforeEach(async () => {
  useMemoryStorage();
  await resetWallet();
  const keys = await generateSigningKeyPair();
  issuerDb = openIssuerDb(':memory:');
  issuer = createIssuerApp(issuerDb, keys, undefined, { seedStaff: STAFF });
  verifier = createVerifierApp(openVerifierDb(':memory:'), (id) => (id === ISSUER_ID ? { publicJwk: keys.publicJwk, state: 'Active' } : null));
  fetchStub = async (url, init) => issuer.request(new URL(url).pathname, init);
});

describe('holder requests', () => {
  it('approved: the wallet collects the credential by itself and it verifies', async () => {
    await ask('ait2023002', '2004-11-02'); // Isha, correct date of birth; typed in lower case
    expect((await getMyRequests())[0]).toMatchObject({ status: 'pending', pnr: 'AIT2023002' });
    expect((await refresh())[0].status).toBe('pending'); // nothing decided yet
    expect(await getCredentials()).toHaveLength(0);

    const token = await signIn('S-002', '2222');
    const waiting = (await inbox(token)).requests;
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ ref: 'REQ-1', pnrFound: true, dobMatches: true, studentName: 'Isha Kulkarni', type: 'StudentCredential' });
    expect((await issuer.request('/v1/requests-inbox/REQ-1/approve', json({}, token))).status).toBe(200);

    const after = await refresh();
    expect(after[0]).toMatchObject({ status: 'approved', note: 'Added to your wallet' });
    const cards = await getCredentials();
    expect(cards).toHaveLength(1);
    expect((await readCredential(cards[0].credential)).name).toBe('Isha Kulkarni');

    // The collected credential is a normal one: it verifies.
    const holder = await getHolderKey();
    const { requestId } = await (await verifier.request('/v1/requests', json({ verifierId: 'verifier:campus-store' }))).json();
    const object = await (await verifier.request(`/v1/requests/${requestId}/object`)).json();
    const presentation = await createPresentation({ credential: cards[0].credential, holderPrivateKey: holder.privateKey, claims: object.claims, nonce: object.nonce, audience: object.verifierId });
    expect((await (await verifier.request(`/v1/requests/${requestId}/response`, json({ presentation }))).json()).state).toBe('verified');

    // Checking again does nothing more: no second card.
    await refresh();
    expect(await getCredentials()).toHaveLength(1);
  });

  it('rejected shows Rejected and nothing is added', async () => {
    await ask('AIT2023002', '2004-11-02');
    const token = await signIn('S-002', '2222');
    expect((await issuer.request('/v1/requests-inbox/REQ-1/reject', json({}, token))).status).toBe(200);
    expect((await refresh())[0].status).toBe('rejected');
    expect(await getCredentials()).toHaveLength(0);
    expect((await issuer.request('/v1/requests-inbox/REQ-1/approve', json({}, token))).status).toBe(409); // already decided
  });

  it('wrong date of birth or unknown PNR is shown to staff and cannot be approved; the holder is told nothing', async () => {
    const wrongDate = await ask('AIT2023002', '1999-01-01');
    const unknown = await ask('NOSUCH999', '2004-11-02');
    expect(wrongDate.status).toBe('pending'); // same answer either way: no guessing game
    expect(unknown.status).toBe('pending');

    const token = await signIn('S-002', '2222');
    const waiting = (await inbox(token)).requests as { ref: string; pnrFound: boolean; dobMatches: boolean; studentName: string | null }[];
    expect(waiting.find((r) => r.ref === 'REQ-1')).toMatchObject({ pnrFound: true, dobMatches: false });
    expect(waiting.find((r) => r.ref === 'REQ-2')).toMatchObject({ pnrFound: false, dobMatches: false, studentName: null });

    const first = await issuer.request('/v1/requests-inbox/REQ-1/approve', json({}, token));
    expect((await first.json()).error.code).toBe('dob_mismatch');
    const second = await issuer.request('/v1/requests-inbox/REQ-2/approve', json({}, token));
    expect((await second.json()).error.code).toBe('pnr_not_found');
    expect((await refresh()).every((r) => r.status === 'pending')).toBe(true);
  });

  it('only the issuer role decides; staff never see the holder\'s secret id; the typed date is not stored', async () => {
    const mine = await ask('AIT2023002', '2004-11-02');
    const revoker = await signIn('S-003', '3333');
    expect((await issuer.request('/v1/requests-inbox/REQ-1/approve', json({}, revoker))).status).toBe(403);
    expect((await issuer.request('/v1/requests-inbox/REQ-1/reject', json({}, revoker))).status).toBe(403);
    expect((await issuer.request('/v1/requests-inbox')).status).toBe(401);

    const list = JSON.stringify(await inbox(revoker)); // any staff may read the list
    expect(list).not.toContain(mine.id);
    const audit = JSON.stringify(issuerDb.prepare('SELECT * FROM audit_events').all());
    expect(audit).not.toContain(mine.id);
    expect(audit).toContain('REQ-1');
    expect(JSON.stringify(issuerDb.prepare('SELECT * FROM credential_requests').all())).not.toContain('2004-11-02');
    expect(JSON.stringify(await getMyRequests())).not.toContain('2004-11-02');
  });

  it('a made-up request id gets nothing', async () => {
    expect((await issuer.request('/v1/credential-requests/not-a-real-id')).status).toBe(404);
    expect((await issuer.request('/v1/credential-requests', json({ type: 'Passport', pnr: 'AIT2023002', dob: '2004-11-02' }))).status).toBe(400);
  });
});
