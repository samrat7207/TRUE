// Tests for the shared wallet logic (packages/wallet-core) and the per-step verification report.
// The wallet talks to in-process issuer and verifier apps through a stand-in for fetch.
import { beforeAll, describe, expect, it } from 'vitest';
import { ISSUER_ID } from '@true/shared';
import { generateSigningKeyPair, inspectCredential, type IssuerKeyInfo, type Jwk, type VerifierInfo } from '@true/credentials';
import {
  answerRequest, claimCredential, getCredentials, getHistory, getSettings, loadRequest, parseScanned, pickCredential,
  resetWallet, saveSettings, useMemoryStorage, type Fetch,
} from '@true/wallet-core';
import { openIssuerDb } from '../services/issuer-api/src/db.ts';
import { createIssuerApp, type IssuerChain } from '../services/issuer-api/src/app.ts';
import { openVerifierDb, DEMO_VERIFIERS } from '../services/verifier-api/src/db.ts';
import { createVerifierApp } from '../services/verifier-api/src/app.ts';
import { setRevoked } from '../services/verifier-api/src/sync.ts';
import { buildSteps, STEP_NAMES } from '../services/verifier-api/src/steps.ts';

const ISSUER_API = 'http://localhost:4001';
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

let issuer: ReturnType<typeof createIssuerApp>;
let verifier: ReturnType<typeof createVerifierApp>;
let verifierDb: ReturnType<typeof openVerifierDb>;
let fetchStub: Fetch;
const issuerKeys = new Map<string, IssuerKeyInfo>();
const verifiers = new Map<string, VerifierInfo>();
const getIssuerKey = (id: string, keyId: string) => (id === ISSUER_ID ? issuerKeys.get(keyId) ?? null : null);
const getVerifier = (id: string) => verifiers.get(id) ?? null;

beforeAll(async () => {
  useMemoryStorage(); // Node has no IndexedDB
  const chain: IssuerChain = {
    addIssuerKey: async (keyId, publicJwk) => issuerKeys.set(keyId, { publicJwk, state: 'Active' }),
    setIssuerKeyState: async (keyId, state) => { issuerKeys.get(keyId)!.state = state; },
    anchorStatusList: async () => {},
  };
  const firstKey = await generateSigningKeyPair();
  issuerKeys.set('key-1', { publicJwk: firstKey.publicJwk, state: 'Active' });
  issuer = createIssuerApp(openIssuerDb(':memory:'), firstKey, chain);

  const privateKeys: Record<string, Jwk> = {};
  for (const v of DEMO_VERIFIERS) {
    const pair = await generateSigningKeyPair();
    privateKeys[v.id] = pair.privateJwk;
    if (v.registered) verifiers.set(v.id, { name: v.name, allowedClaims: v.claims, publicJwk: pair.publicJwk });
  }
  verifierDb = openVerifierDb(':memory:');
  verifier = createVerifierApp(verifierDb, getIssuerKey, { verifierKeys: privateKeys });

  // Send issuer addresses to the issuer app and everything else to the verifier app.
  fetchStub = async (url, init) => {
    const path = new URL(url).pathname;
    return url.startsWith(ISSUER_API) ? issuer.request(path, init) : verifier.request(path, init);
  };
});

// A verifier creates a request; returns the address the wallet would get from the QR code.
async function newRequest(body: object): Promise<string> {
  const { requestUri } = await (await verifier.request('/v1/requests', json(body))).json();
  return requestUri;
}
const claimFor = async (studentId: number) => {
  const { code } = await (await issuer.request('/v1/claim-codes', json({ studentId }))).json();
  return claimCredential({ code, issuerApi: ISSUER_API, fetch: fetchStub });
};

describe('reading what was scanned', () => {
  it('recognises verifier links, offer links, bare addresses and bare codes', () => {
    expect(parseScanned('http://localhost:5173/#/present?request_uri=http%3A%2F%2Flocalhost%3A4000%2Fv1%2Frequests%2Fab12%2Fobject'))
      .toEqual({ kind: 'present', requestUri: 'http://localhost:4000/v1/requests/ab12/object' });
    expect(parseScanned('http://localhost:4000/v1/requests/ab12/object')).toEqual({ kind: 'present', requestUri: 'http://localhost:4000/v1/requests/ab12/object' });
    expect(parseScanned('http://localhost:5173/#/claim?code=abcd2345')).toEqual({ kind: 'claim', code: 'ABCD2345' });
    expect(parseScanned('  abcd2345 ')).toEqual({ kind: 'claim', code: 'ABCD2345' });
    expect(parseScanned('hello')).toEqual({ kind: 'unknown' });
    expect(parseScanned('https://example.com')).toEqual({ kind: 'unknown' });
  });
});

describe('wallet flows', () => {
  it('claim stores one card; claiming again for the same student replaces it', async () => {
    const first = await claimFor(1);
    expect(await getCredentials()).toHaveLength(1);
    const second = await claimFor(1);
    const cards = await getCredentials();
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe(second.id);
    expect(cards[0].id).not.toBe(first.id);
  });

  it('a bad claim code throws the issuer reason', async () => {
    await expect(claimCredential({ code: 'ZZZZZZZZ', issuerApi: ISSUER_API, fetch: fetchStub })).rejects.toThrow('This claim code does not exist');
  });

  it('the wallet can check its own card against the registry', async () => {
    const card = pickCredential(await getCredentials())!;
    const check = await inspectCredential(card.credential, getIssuerKey);
    expect(check).toMatchObject({ status: 'verified', issuer: ISSUER_ID, keyId: 'key-1', type: 'StudentCredential' });
    expect(check.expiresAt).toBeGreaterThan(check.issuedAt);
    expect((await inspectCredential(card.credential, () => null)).status).toBe('unknown_issuer');
    expect((await inspectCredential(card.credential, () => ({ ...issuerKeys.get('key-1')!, state: 'Compromised' }))).status).toBe('key_compromised');
    const otherKey = (await generateSigningKeyPair()).publicJwk;
    expect((await inspectCredential(card.credential, () => ({ publicJwk: otherKey, state: 'Active' }))).status).toBe('bad_signature');
  });

  it('approve: verified, with every step passed and the cryptographic details', async () => {
    const check = await loadRequest({ requestUri: await newRequest({ verifierId: 'verifier:nova-arena' }), fetch: fetchStub, getVerifier });
    expect(check.status).toBe('verified');
    if (check.status !== 'verified') return;
    const answer = await answerRequest({ check, stored: pickCredential(await getCredentials())!, approve: true, fetch: fetchStub });
    expect(answer).toMatchObject({ decision: 'shared', state: 'verified', code: null, issuer: ISSUER_ID, keyId: 'key-1', sharedClaims: ['age_over_18'] });
    expect(answer.steps.map((s) => s.name)).toEqual([...STEP_NAMES]);
    expect(answer.steps.every((s) => s.status === 'pass')).toBe(true);
    expect(new Date(answer.verifiedAt!).getTime()).toBeGreaterThan(0);
    expect((await getHistory())[0]).toMatchObject({ verifierName: 'Nova Arena', decision: 'shared', outcome: 'verified' });
  });

  it('the step report carries no personal data', async () => {
    const check = await loadRequest({ requestUri: await newRequest({ verifierId: 'verifier:city-library' }), fetch: fetchStub, getVerifier });
    if (check.status !== 'verified') throw new Error('expected verified');
    const answer = await answerRequest({ check, stored: pickCredential(await getCredentials())!, approve: true, fetch: fetchStub });
    const report = JSON.stringify({ steps: answer.steps, keyId: answer.keyId, verifiedAt: answer.verifiedAt });
    for (const personal of ['Aarav', 'AIT2023001', 'Lake View', '2005-03-14']) expect(report).not.toContain(personal);
  });

  it('decline: nothing shared, recorded as declined', async () => {
    const check = await loadRequest({ requestUri: await newRequest({ verifierId: 'verifier:campus-store' }), fetch: fetchStub, getVerifier });
    if (check.status !== 'verified') throw new Error('expected verified');
    const answer = await answerRequest({ check, stored: pickCredential(await getCredentials())!, approve: false, fetch: fetchStub });
    expect(answer).toMatchObject({ decision: 'declined', state: 'denied', code: 'user_declined', sharedClaims: [] });
  });

  it('unregistered verifier and over-asking are reported before anything is sent', async () => {
    const fake = await loadRequest({ requestUri: await newRequest({ verifierId: 'verifier:free-prize-booth' }), fetch: fetchStub, getVerifier });
    expect(fake.status).toBe('unregistered');
    const greedy = await loadRequest({ requestUri: await newRequest({ verifierId: 'verifier:nova-arena', claims: ['age_over_18', 'address'] }), fetch: fetchStub, getVerifier });
    expect(greedy).toMatchObject({ status: 'verified', extraClaims: ['address'] });
  });

  it('revoked: the failing step is revocation, later steps are skipped, and the card is marked', async () => {
    const card = pickCredential(await getCredentials())!;
    const index = (await (await issuer.request('/v1/students')).json()).students[0].status_list_index;
    setRevoked(verifierDb, index); // what the verifier's scheduled refresh would do after the issuer revokes
    const check = await loadRequest({ requestUri: await newRequest({ verifierId: 'verifier:campus-store' }), fetch: fetchStub, getVerifier });
    if (check.status !== 'verified') throw new Error('expected verified');
    const answer = await answerRequest({ check, stored: card, approve: true, fetch: fetchStub });
    expect(answer).toMatchObject({ state: 'denied', code: 'revoked' });
    const byName = Object.fromEntries(answer.steps.map((s) => [s.name, s.status]));
    expect(byName).toMatchObject({ issuer_signature: 'pass', freshness: 'pass', revocation_status: 'fail', required_claims: 'skipped' });
    expect((await getCredentials())[0].revoked).toBe(true);
  });

  it('settings are kept on the device, and reset wipes everything', async () => {
    await saveSettings({ holderName: 'Test Holder' });
    await saveSettings({ issuerApi: 'http://example.test' });
    expect(await getSettings()).toEqual({ holderName: 'Test Holder', issuerApi: 'http://example.test' });
    await resetWallet();
    expect(await getCredentials()).toEqual([]);
    expect(await getHistory()).toEqual([]);
    expect(await getSettings()).toEqual({});
  });
});

describe('step report', () => {
  it('maps each reason code to the step that failed', () => {
    const failedStep = (code: string) => buildSteps(code).find((s) => s.status === 'fail')!.name;
    expect(failedStep('tampered_disclosure')).toBe('proof_integrity');
    expect(failedStep('issuer_key_compromised')).toBe('issuer_key_state');
    expect(failedStep('unknown_issuer')).toBe('issuer_key_state');
    expect(failedStep('bad_signature')).toBe('issuer_signature');
    expect(failedStep('wrong_audience')).toBe('holder_and_audience');
    expect(failedStep('nonce_mismatch')).toBe('freshness');
    expect(failedStep('requirement_not_met')).toBe('required_claims');
  });

  it('never claims a pass for a check that was not reached', () => {
    const steps = buildSteps('bad_signature');
    expect(steps.slice(0, 2).every((s) => s.status === 'pass')).toBe(true);
    expect(steps.slice(3).every((s) => s.status === 'skipped')).toBe(true);
    // Holder binding and freshness are checked together by the library; a freshness failure says nothing about the other.
    expect(buildSteps('nonce_mismatch').find((s) => s.name === 'holder_and_audience')!.status).toBe('skipped');
  });
});
