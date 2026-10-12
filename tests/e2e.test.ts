// End-to-end story on a fresh start, with an in-memory stand-in for the chain registry:
// issue -> Verified, revoke -> Revoked, key compromised -> issuer_key_compromised.
// Also covers the wallet bug behind "key undefined is not in the registry": presenting an old card.
import { describe, expect, it } from 'vitest';
import { decodeProtectedHeader } from 'jose';
import { ISSUER_ID } from '@true/shared';
import { createHolderProof, createPresentation, generateHolderKey, generateSigningKeyPair, sha256Hex, type IssuerKeyInfo } from '@true/credentials';
import { openIssuerDb } from '../services/issuer-api/src/db.ts';
import { createIssuerApp, type IssuerChain } from '../services/issuer-api/src/app.ts';
import { openVerifierDb } from '../services/verifier-api/src/db.ts';
import { createVerifierApp } from '../services/verifier-api/src/app.ts';
import { refreshStatusList } from '../services/verifier-api/src/sync.ts';
import { pickCredential } from '../apps/wallet/src/storage.ts';

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
type Holder = Awaited<ReturnType<typeof generateHolderKey>>;

describe('fresh start, end to end', () => {
  it('issue -> Verified, revoke -> Revoked, compromised key -> denied', async () => {
    // Fresh start: empty databases, empty registry. The issuer publishes its first key like server.ts does.
    const registry = new Map<string, IssuerKeyInfo>();
    let anchorHash = '';
    const chain: IssuerChain = {
      addIssuerKey: async (keyId, publicJwk) => registry.set(keyId, { publicJwk, state: 'Active' }),
      setIssuerKeyState: async (keyId, state) => { registry.get(keyId)!.state = state; },
      anchorStatusList: async (hash) => { anchorHash = hash; },
    };
    const firstKey = await generateSigningKeyPair();
    const issuer = createIssuerApp(openIssuerDb(':memory:'), firstKey, chain, { staffAuth: 'off' });
    await chain.addIssuerKey('key-1', firstKey.publicJwk);
    const verifierDb = openVerifierDb(':memory:');
    const verifier = createVerifierApp(verifierDb, (id, keyId) => (id === ISSUER_ID ? registry.get(keyId) ?? null : null));

    async function issue(studentId: number, holder: Holder) {
      const { code } = await (await issuer.request('/v1/claim-codes', json({ studentId }))).json();
      const offer = await (await issuer.request(`/v1/claim-codes/${code}`)).json();
      const proof = await createHolderProof({ holderPrivateKey: holder.privateKey, holderPublicJwk: holder.publicJwk, nonce: offer.nonce, audience: ISSUER_ID });
      return (await (await issuer.request('/v1/credentials', json({ code, proof }))).json()).credential as string;
    }
    async function present(credential: string, holder: Holder, verifierId: string) {
      const { requestId } = await (await verifier.request('/v1/requests', json({ verifierId }))).json();
      const object = await (await verifier.request(`/v1/requests/${requestId}/object`)).json();
      const presentation = await createPresentation({ credential, holderPrivateKey: holder.privateKey, claims: object.claims, nonce: object.nonce, audience: object.verifierId });
      await verifier.request(`/v1/requests/${requestId}/response`, json({ presentation }));
      return (await verifier.request(`/v1/requests/${requestId}`)).json();
    }
    // What each verifier instance does on its timer.
    const refresh = async () => {
      const list = await (await issuer.request('/v1/status-list')).json();
      return refreshStatusList(verifierDb, { fetchList: async () => list, getAnchorHash: async () => anchorHash, hash: sha256Hex });
    };

    // 1. Issue: the credential names the key that signed it, and that key id is in the registry.
    const alice = await generateHolderKey();
    const aliceCredential = await issue(1, alice);
    expect(decodeProtectedHeader(aliceCredential.split('~')[0]).kid).toBe('key-1');
    expect(registry.has('key-1')).toBe(true);

    // 2. Verify at both verifiers.
    expect((await present(aliceCredential, alice, 'verifier:campus-store')).state).toBe('verified');
    expect((await present(aliceCredential, alice, 'verifier:nova-arena')).state).toBe('verified');

    // 3. Revoke -> after the scheduled refresh the same credential is Revoked.
    expect((await issuer.request('/v1/students/1/revoke', json({ reason: 'left_institution' }))).status).toBe(200);
    expect(await refresh()).toBe('updated');
    const revoked = await present(aliceCredential, alice, 'verifier:campus-store');
    expect(revoked).toMatchObject({ state: 'denied', result: { code: 'revoked' } });

    // 4. Another student, then the key is marked compromised -> that credential is denied.
    const bob = await generateHolderKey();
    const bobCredential = await issue(2, bob);
    expect((await present(bobCredential, bob, 'verifier:campus-store')).state).toBe('verified');
    await issuer.request('/v1/keys/key-1/compromise', json({}));
    const compromised = await present(bobCredential, bob, 'verifier:campus-store');
    expect(compromised).toMatchObject({ state: 'denied', result: { code: 'issuer_key_compromised' } });

    // 5. Re-issued under the new key, Bob verifies again.
    const bobAgain = await issue(2, bob);
    expect(decodeProtectedHeader(bobAgain.split('~')[0]).kid).toBe('key-2');
    expect((await present(bobAgain, bob, 'verifier:campus-store')).state).toBe('verified');
  });

  it('the wallet presents the newest card, not an old one left in the wallet', () => {
    const cards = [
      { id: 'old', addedAt: '2026-10-12T09:02:35.712Z' }, // issued before key ids existed
      { id: 'new', addedAt: '2026-10-12T14:50:28.918Z' },
    ];
    expect(pickCredential(cards)!.id).toBe('new');
    expect(pickCredential([])).toBeUndefined();
  });
});
