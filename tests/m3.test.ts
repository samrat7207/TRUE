// M3 tests: the wallet authenticates the verifier before showing a request.
import { beforeAll, describe, expect, it } from 'vitest';
import { authenticateRequest, generateSigningKeyPair, type Jwk, type VerifierInfo } from '@true/credentials';
import { openVerifierDb, DEMO_VERIFIERS } from '../services/verifier-api/src/db.ts';
import { createVerifierApp } from '../services/verifier-api/src/app.ts';

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

let verifier: ReturnType<typeof createVerifierApp>;
const registry = new Map<string, VerifierInfo>(); // stand-in for the on-chain verifier registry
const lookup = (id: string) => registry.get(id) ?? null;

beforeAll(async () => {
  const privateKeys: Record<string, Jwk> = {};
  for (const v of DEMO_VERIFIERS) {
    const pair = await generateSigningKeyPair();
    privateKeys[v.id] = pair.privateJwk;
    // Same rule as scripts/chain-setup.ts: the fake verifier has a key but is NOT registered.
    if (v.registered) registry.set(v.id, { name: v.name, allowedClaims: v.claims, publicJwk: pair.publicJwk });
  }
  verifier = createVerifierApp(openVerifierDb(':memory:'), () => null, { verifierKeys: privateKeys });
});

// Create a request and return the signed request the wallet would receive.
async function signedRequestFor(body: object): Promise<string> {
  const { requestId } = await (await verifier.request('/v1/requests', json(body))).json();
  return (await (await verifier.request(`/v1/requests/${requestId}/object`)).json()).signedRequest;
}

describe('verifier authentication', () => {
  it('a registered verifier with a valid signature is shown by its registry name', async () => {
    const check = await authenticateRequest(await signedRequestFor({ verifierId: 'verifier:nova-arena' }), lookup);
    expect(check.status).toBe('verified');
    if (check.status !== 'verified') return;
    expect(check.verifierName).toBe('Nova Arena');
    expect(check.request.claims).toEqual(['dob']);
    expect(check.extraClaims).toEqual([]);
  });

  it('an unregistered verifier is blocked', async () => {
    const check = await authenticateRequest(await signedRequestFor({ verifierId: 'verifier:free-prize-booth' }), lookup);
    expect(check).toEqual({ status: 'unregistered', claimedBy: 'verifier:free-prize-booth' });
  });

  it('a tampered request is blocked', async () => {
    const signed = await signedRequestFor({ verifierId: 'verifier:nova-arena' });
    // Change the claims inside the signed request to ask for the address as well.
    const [header, payload, signature] = signed.split('.');
    const content = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    content.claims = ['dob', 'address'];
    const forged = [header, Buffer.from(JSON.stringify(content)).toString('base64url'), signature].join('.');
    expect((await authenticateRequest(forged, lookup)).status).toBe('tampered');
  });

  it('a request signed by another key under a registered name is blocked', async () => {
    // The fake booth signs with its own key but we look it up as if it were the library: the keys do not match.
    const signed = await signedRequestFor({ verifierId: 'verifier:free-prize-booth' });
    const impersonating = (id: string) => (id === 'verifier:free-prize-booth' ? registry.get('verifier:city-library')! : null);
    expect((await authenticateRequest(signed, impersonating)).status).toBe('tampered');
  });

  it('an unsigned or unreadable request is blocked', async () => {
    expect((await authenticateRequest('', lookup)).status).toBe('tampered');
    expect((await authenticateRequest('not-a-jwt', lookup)).status).toBe('tampered');
  });

  it('over-asking is flagged: claims beyond the registration are listed', async () => {
    const check = await authenticateRequest(await signedRequestFor({ verifierId: 'verifier:nova-arena', claims: ['dob', 'address'] }), lookup);
    expect(check.status).toBe('verified');
    if (check.status !== 'verified') return;
    expect(check.extraClaims).toEqual(['address']);
  });
});
