// M2 tests: issuer key rotation and compromise, with an in-memory stand-in for the chain registry.
// (The real contract has its own tests: npm run chain:test.)
import { describe, expect, it } from 'vitest';
import { ISSUER_ID, isBitSet } from '@true/shared';
import { createHolderProof, createPresentation, generateHolderKey, generateSigningKeyPair, type IssuerKeyInfo, type Jwk } from '@true/credentials';
import { openIssuerDb } from '../services/issuer-api/src/db.ts';
import { createIssuerApp, type IssuerChain } from '../services/issuer-api/src/app.ts';
import { openVerifierDb } from '../services/verifier-api/src/db.ts';
import { createVerifierApp } from '../services/verifier-api/src/app.ts';

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// Builds an issuer and a verifier that share a fake registry: the issuer writes keys, the verifier reads them.
async function setup() {
  const registry = new Map<string, IssuerKeyInfo>();
  const anchors: { hash: string; version: number }[] = [];
  const chain: IssuerChain = {
    addIssuerKey: async (keyId: string, publicJwk: Jwk) => registry.set(keyId, { publicJwk, state: 'Active' }),
    setIssuerKeyState: async (keyId, state) => { registry.get(keyId)!.state = state; },
    anchorStatusList: async (hash, version) => anchors.push({ hash, version }),
  };
  const firstKey = await generateSigningKeyPair();
  registry.set('key-1', { publicJwk: firstKey.publicJwk, state: 'Active' });
  const issuer = createIssuerApp(openIssuerDb(':memory:'), firstKey, chain);
  const verifier = createVerifierApp(openVerifierDb(':memory:'), (id, keyId) => (id === ISSUER_ID ? registry.get(keyId) ?? null : null));

  async function issue(studentId: number) {
    const holder = await generateHolderKey();
    const { code } = await (await issuer.request('/v1/claim-codes', json({ studentId }))).json();
    const offer = await (await issuer.request(`/v1/claim-codes/${code}`)).json();
    const proof = await createHolderProof({ holderPrivateKey: holder.privateKey, holderPublicJwk: holder.publicJwk, nonce: offer.nonce, audience: ISSUER_ID });
    const { credential } = await (await issuer.request('/v1/credentials', json({ code, proof }))).json();
    return { holder, credential: credential as string };
  }

  async function present(holder: Awaited<ReturnType<typeof generateHolderKey>>, credential: string) {
    const { requestId } = await (await verifier.request('/v1/requests', json({ verifierId: 'verifier:campus-store' }))).json();
    const object = await (await verifier.request(`/v1/requests/${requestId}/object`)).json();
    const presentation = await createPresentation({
      credential, holderPrivateKey: holder.privateKey, claims: object.claims, nonce: object.nonce, audience: object.verifierId,
    });
    await verifier.request(`/v1/requests/${requestId}/response`, json({ presentation }));
    return (await verifier.request(`/v1/requests/${requestId}`)).json();
  }

  return { issuer, registry, anchors, issue, present };
}

describe('issuer keys', () => {
  it('normal rotation: old credentials keep working, new ones use the new key', async () => {
    const { issuer, registry, issue, present } = await setup();
    const old = await issue(1);
    const rotated = await (await issuer.request('/v1/keys/rotate', json({}))).json();
    expect(rotated).toMatchObject({ activeKeyId: 'key-2', retiredKeyId: 'key-1' });
    expect(registry.get('key-1')!.state).toBe('Retired');

    expect((await present(old.holder, old.credential)).state).toBe('verified');
    const fresh = await issue(2);
    expect((await present(fresh.holder, fresh.credential)).state).toBe('verified');
  });

  it('compromised key: everything it signed is rejected, and a new key takes over', async () => {
    const { issuer, registry, issue, present } = await setup();
    const old = await issue(1);
    expect((await present(old.holder, old.credential)).state).toBe('verified');

    const response = await (await issuer.request('/v1/keys/key-1/compromise', json({}))).json();
    expect(response.activeKeyId).toBe('key-2');
    expect(registry.get('key-1')!.state).toBe('Compromised');

    const after = await present(old.holder, old.credential);
    expect(after.state).toBe('denied');
    expect(after.result.code).toBe('issuer_key_compromised');

    // Re-issued under the new key, the same student verifies again.
    const reissued = await issue(1);
    expect((await present(reissued.holder, reissued.credential)).state).toBe('verified');
  });

  it('give back after revoking: reason required, old credential stays revoked, new one gets a new position', async () => {
    const { issuer, issue, present } = await setup();
    const old = await issue(1);
    const students = async () => (await (await issuer.request('/v1/students')).json()).students;
    const oldIndex = (await students())[0].status_list_index;

    // Cannot reinstate someone who is not revoked, and the reason must be filled in with a known code.
    expect((await issuer.request('/v1/students/1/reinstate', json({ reason: 'revoked_in_error' }))).status).toBe(409);
    await issuer.request('/v1/students/1/revoke', json({ reason: 'issued_in_error' }));
    expect((await issuer.request('/v1/students/1/reinstate', json({}))).status).toBe(400);
    expect((await issuer.request('/v1/students/1/reinstate', json({ reason: 'because I say so' }))).status).toBe(400);
    expect((await issuer.request('/v1/claim-codes', json({ studentId: 1 }))).status).toBe(409); // still revoked

    expect((await issuer.request('/v1/students/1/reinstate', json({ reason: 'revoked_in_error' }))).status).toBe(200);
    expect((await students())[0]).toMatchObject({ status: 'active', revoked_reason: null, status_list_index: null });

    // The new credential gets a new list position; the old position stays revoked in the published list.
    const fresh = await issue(1);
    const newIndex = (await students())[0].status_list_index;
    expect(newIndex).not.toBe(oldIndex);
    const list = await (await issuer.request('/v1/status-list')).json();
    expect(isBitSet(list.bitsHex, oldIndex)).toBe(true);
    expect(isBitSet(list.bitsHex, newIndex)).toBe(false);
    expect((await present(fresh.holder, fresh.credential)).state).toBe('verified');
    expect(old.credential).not.toBe(fresh.credential);
  });

  it('revoking publishes a new fingerprint with a higher version, and never the reason text or a name', async () => {
    const { issuer, anchors, issue } = await setup();
    await issue(1);
    const revoke = await issuer.request('/v1/students/1/revoke', json({ reason: 'lost_device' }));
    expect((await revoke.json()).anchored).toBe(true);
    expect(anchors).toHaveLength(1);
    expect(anchors[0].version).toBe(1);
    expect(anchors[0].hash).toMatch(/^[0-9a-f]{64}$/);
    // Free-text reasons are refused, so personal details cannot be typed into the record.
    expect((await issuer.request('/v1/students/2/revoke', json({ reason: 'he moved to Pune' }))).status).toBe(400);
    expect((await issuer.request('/v1/students/1/revoke', json({ reason: 'lost_device' }))).status).toBe(409);
  });
});
