// The cryptographic promises: selective disclosure, and each attack that must fail.
import { beforeEach, describe, expect, it } from 'vitest';
import { createPresentation, disclosedClaimNames, generateHolderKey, inspectCredential } from '@true/credentials';
import { getHolderKey, matchingCredentials, parseScanned } from '@true/wallet-core';
import { buildSteps, STEP_NAMES } from '../services/verifier-api/src/steps.ts';
import { FIELDS, json, world } from './helpers.ts';

let w: Awaited<ReturnType<typeof world>>;
beforeEach(async () => { w = await world(); });

// A verifier request, and a way to answer it with a hand-made presentation.
async function openRequest(verifierId: string) {
  const { requestId } = await (await w.verifier.request('/v1/requests', json({ verifierId }))).json();
  const object = await (await w.verifier.request(`/v1/requests/${requestId}/object`)).json();
  return { requestId: requestId as string, object };
}
const respond = (requestId: string, presentation: string) => w.verifier.request(`/v1/requests/${requestId}/response`, json({ presentation }));
const stateOf = async (requestId: string) => (await w.verifier.request(`/v1/requests/${requestId}`)).json();

describe('selective disclosure', () => {
  it('only the requested field leaves the wallet; everything else is absent from what is sent', async () => {
    const { card } = await w.issueTo('aarav@test.true');
    const holder = await getHolderKey();
    const presentation = await createPresentation({ credential: card.credential, holderPrivateKey: holder.privateKey, claims: ['name'], nonce: 'n', audience: 'verifier:campus-store' });
    expect(disclosedClaimNames(presentation)).toEqual(['name']);
    const plainText = presentation.split(/[~.]/).map((part) => Buffer.from(part, 'base64url').toString('utf8')).join(' ');
    for (const hidden of ['AIT2023001', '2005-03-14', 'Lake View', 'B+', '+91 90000', 'Computer Engineering']) expect(plainText).not.toContain(hidden);
  });

  it('a verified answer carries every check, the key id and no personal data in the step report', async () => {
    const { card } = await w.issueTo('aarav@test.true');
    const answer = await w.present(card, 'verifier:city-library');
    expect(answer).toMatchObject({ state: 'verified', keyId: 'key-1', sharedClaims: ['name', 'id_number'] });
    expect(answer.steps.map((s) => s.name)).toEqual([...STEP_NAMES]);
    expect(answer.steps.every((s) => s.status === 'pass')).toBe(true);
    expect(JSON.stringify(answer.steps)).not.toContain('Aarav');
  });
});

describe('attacks', () => {
  it('tamper: a changed disclosure value is not accepted', async () => {
    const { card } = await w.issueTo('aarav@test.true');
    const holder = await getHolderKey();
    const { requestId, object } = await openRequest('verifier:campus-store');
    const presentation = await createPresentation({ credential: card.credential, holderPrivateKey: holder.privateKey, claims: ['name'], nonce: object.nonce, audience: object.verifierId });
    const parts = presentation.split('~');
    const disclosure = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    disclosure[2] = 'Someone Else';
    parts[1] = Buffer.from(JSON.stringify(disclosure)).toString('base64url');
    await respond(requestId, parts.join('~'));
    expect((await stateOf(requestId)).state).toBe('denied');
  });

  it('replay: the same presentation cannot be used twice', async () => {
    const { card } = await w.issueTo('aarav@test.true');
    const holder = await getHolderKey();
    const first = await openRequest('verifier:campus-store');
    const presentation = await createPresentation({ credential: card.credential, holderPrivateKey: holder.privateKey, claims: ['name'], nonce: first.object.nonce, audience: first.object.verifierId });
    expect((await respond(first.requestId, presentation)).status).toBe(200);
    expect((await respond(first.requestId, presentation)).status).toBe(409); // already answered
    const second = await openRequest('verifier:campus-store');
    await respond(second.requestId, presentation);
    expect((await stateOf(second.requestId)).result.code).toBe('nonce_mismatch'); // a new request has a new nonce
  });

  it('wrong audience: a proof made for one verifier fails at another', async () => {
    const { card } = await w.issueTo('aarav@test.true');
    const holder = await getHolderKey();
    const { requestId, object } = await openRequest('verifier:campus-store');
    const presentation = await createPresentation({ credential: card.credential, holderPrivateKey: holder.privateKey, claims: ['name'], nonce: object.nonce, audience: 'verifier:nova-arena' });
    await respond(requestId, presentation);
    expect((await stateOf(requestId)).result.code).toBe('wrong_audience');
  });

  it('stolen credential: presenting without the holder key fails', async () => {
    const { card } = await w.issueTo('aarav@test.true');
    const thief = await generateHolderKey();
    const { requestId, object } = await openRequest('verifier:campus-store');
    const presentation = await createPresentation({ credential: card.credential, holderPrivateKey: thief.privateKey, claims: ['name'], nonce: object.nonce, audience: object.verifierId });
    await respond(requestId, presentation);
    expect((await stateOf(requestId)).state).toBe('denied');
  });

  it('compromised issuer key: everything it signed is rejected; an unknown issuer is rejected too', async () => {
    const { card, institution } = await w.issueTo('aarav@test.true');
    expect((await w.present(card)).state).toBe('verified');
    w.chainState.keys.get(`${institution.id}/key-1`)!.state = 'Compromised';
    expect(await w.present(card)).toMatchObject({ state: 'denied', code: 'issuer_key_compromised' });
    w.chainState.keys.delete(`${institution.id}/key-1`);
    expect(await w.present(card)).toMatchObject({ state: 'denied', code: 'unknown_issuer' });
  });

  it('a retired key still verifies what it signed (only Compromised rejects)', async () => {
    const { card, institution } = await w.issueTo('aarav@test.true');
    w.chainState.keys.get(`${institution.id}/key-1`)!.state = 'Retired';
    expect((await w.present(card)).state).toBe('verified');
  });
});

describe('the wallet', () => {
  it('checks its own card against the registry', async () => {
    const { card, institution } = await w.issueTo('aarav@test.true');
    expect(await inspectCredential(card.credential, w.getIssuerKey)).toMatchObject({ status: 'verified', issuer: institution.id, keyId: 'key-1', type: 'StudentID' });
    expect((await inspectCredential(card.credential, () => null)).status).toBe('unknown_issuer');
  });

  it('offers only cards that hold the requested fields, and only the pinned institution and type when pinned', async () => {
    const student = { addedAt: '2026-10-01', issuerId: 'inst:college', claims: { vct: 'StudentID', ...FIELDS.StudentID } };
    const gym = { addedAt: '2026-10-05', issuerId: 'inst:gym', claims: { vct: 'GymMembership', ...FIELDS.GymMembership } };
    expect(matchingCredentials([student, gym], ['name', 'blood_group'])).toEqual([gym, student]); // both can; newest first
    expect(matchingCredentials([student, gym], ['address'])).toEqual([student]);
    expect(matchingCredentials([student, gym], ['name', 'blood_group'], { issuer: 'inst:college', type: 'StudentID' })).toEqual([student]);
    expect(matchingCredentials([student, gym], ['name'], { issuer: 'inst:college', type: 'LibraryCard' })).toEqual([]);
  });

  it('reads a scanned verifier link or a bare request address, and nothing else', () => {
    expect(parseScanned('http://localhost:5176/#/consent?request_uri=http%3A%2F%2Flocalhost%3A4000%2Fv1%2Frequests%2Fab12%2Fobject')).toBe('http://localhost:4000/v1/requests/ab12/object');
    expect(parseScanned('http://localhost:4000/v1/requests/ab12/object')).toBe('http://localhost:4000/v1/requests/ab12/object');
    expect(parseScanned('hello')).toBeNull();
  });
});

describe('step report', () => {
  it('never claims a pass for a check that was not reached', () => {
    const failedStep = (code: string) => buildSteps(code).find((s) => s.status === 'fail')!.name;
    expect(failedStep('issuer_key_compromised')).toBe('issuer_key_state');
    expect(failedStep('bad_signature')).toBe('issuer_signature');
    expect(failedStep('revoked')).toBe('revocation_status');
    expect(buildSteps('bad_signature').slice(3).every((s) => s.status === 'skipped')).toBe(true);
    expect(buildSteps('nonce_mismatch').find((s) => s.name === 'holder_and_audience')!.status).toBe('skipped');
  });
});
