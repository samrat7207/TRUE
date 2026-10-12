// The wallet's flows, with no user interface in them: accept an offer, read a verifier's request,
// answer it. Screens call these; tests call them too (with in-process servers instead of the network).
// All cryptography is done by packages/credentials.
import {
  authenticateRequest, createHolderProof, createPresentation,
  type RequestCheck, type VerifierInfo,
} from '@true/credentials';
import { addCredential, addHistory, getCredentials, getHolderKey, markRevoked, type StoredCredential } from './storage.ts';

// How the wallet reaches servers. The browser passes window.fetch; tests pass a stand-in.
export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;

const postJson = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// ---------- what did the user scan or paste? ----------

// Accepts a verifier link (…?request_uri=…) or a bare request address. Returns the request address, or null.
export function parseScanned(text: string): string | null {
  const value = text.trim();
  const requestUri = /[?&]request_uri=([^&\s]+)/.exec(value);
  if (requestUri) return decodeURIComponent(requestUri[1]);
  if (/^https?:\/\/\S+\/v1\/requests\/[0-9a-f]+\/object$/.test(value)) return value;
  return null;
}

// ---------- offers from institutions ----------

export type Offer = {
  id: string; template: string; fields: Record<string, string>; createdAt: string;
  institution: { id: string; name: string; verified: boolean };
};
// How the wallet talks to the core API as the logged-in person.
export type Api = { coreApi: string; token: string; fetch: Fetch };
const authed = (api: Api, body?: unknown) => ({
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${api.token}` },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export async function getOffers(api: Api): Promise<Offer[]> {
  const response = await api.fetch(`${api.coreApi}/v1/me/offers`, authed(api));
  if (!response.ok) throw new Error((await response.json()).error.message);
  return (await response.json()).offers;
}

// Accept an offer. The key is made on THIS device and never leaves it: we sign the offer's nonce to
// prove we own the key, and the institution signs a credential bound to that key.
export async function acceptOffer(api: Api, offerId: string): Promise<StoredCredential> {
  const started = await api.fetch(`${api.coreApi}/v1/me/offers/${offerId}/accept`, authed(api, {}));
  const offer = await started.json();
  if (!started.ok) throw new Error(offer.error.message);
  const holder = await getHolderKey();
  const proof = await createHolderProof({
    holderPrivateKey: holder.privateKey, holderPublicJwk: holder.publicJwk, nonce: offer.nonce, audience: offer.issuerId,
  });
  const response = await api.fetch(`${api.coreApi}/v1/me/offers/${offerId}/claim`, authed(api, { proof }));
  const result = await response.json();
  if (!response.ok) throw new Error(result.error.message);
  await addCredential({ id: result.credentialId, credential: result.credential, issuerId: result.issuerId, issuerName: result.issuerName });
  return (await getCredentials()).find((card) => card.id === result.credentialId)!;
}

export async function rejectOffer(api: Api, offerId: string): Promise<void> {
  const response = await api.fetch(`${api.coreApi}/v1/me/offers/${offerId}/reject`, authed(api, {}));
  if (!response.ok) throw new Error((await response.json()).error.message);
}

// ---------- present ----------

// Fetch a verifier's request and decide who is really asking (signature checked against the registry).
export async function loadRequest(input: {
  requestUri: string;
  fetch: Fetch;
  getVerifier: (verifierId: string) => Promise<VerifierInfo | null> | VerifierInfo | null;
}): Promise<RequestCheck> {
  const response = await input.fetch(input.requestUri);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error.message);
  return authenticateRequest(body.signedRequest ?? '', input.getVerifier);
}

// One line of the verifier's check list.
export type Step = { name: string; status: 'pass' | 'fail' | 'skipped' };

export type Answer = {
  decision: 'shared' | 'declined';
  state: 'verified' | 'denied' | 'error'; // error = the verifier did not process it (expired, already answered, blocked…)
  code: string | null; // reason code when not verified
  message: string | null;
  steps: Step[];
  issuer: string | null;
  keyId: string | null;
  verifiedAt: string | null;
  servedBy: string | null;
  sharedClaims: string[]; // names of the claims that were sent
};

// Answer a request that passed authentication. Only the requested claims are sent,
// signed for this verifier and this nonce. Writes the history entry and marks a revoked card.
export async function answerRequest(input: {
  check: Extract<RequestCheck, { status: 'verified' }>;
  stored: StoredCredential;
  approve: boolean;
  fetch: Fetch;
}): Promise<Answer> {
  const { request } = input.check;
  let body: object = { declined: true };
  if (input.approve) {
    const holder = await getHolderKey();
    const presentation = await createPresentation({
      credential: input.stored.credential, holderPrivateKey: holder.privateKey,
      claims: request.claims, nonce: request.nonce, audience: request.verifierId,
    });
    body = { presentation };
  }
  const response = await input.fetch(request.responseUri, postJson(body));
  const result = await response.json();
  const answer: Answer = {
    decision: input.approve ? 'shared' : 'declined',
    state: response.ok ? result.state : 'error',
    code: response.ok ? result.code ?? null : result.error.code,
    message: response.ok ? result.message ?? null : result.error.message,
    steps: result.steps ?? [],
    issuer: result.issuer ?? null,
    keyId: result.keyId ?? null,
    verifiedAt: result.verifiedAt ?? null,
    servedBy: response.headers.get('X-Served-By'),
    sharedClaims: input.approve ? request.claims : [],
  };
  if (answer.code === 'revoked') await markRevoked(input.stored.id);
  await addHistory({
    at: new Date().toISOString(), verifierName: input.check.verifierName, claims: request.claims,
    decision: answer.decision, outcome: answer.state === 'verified' ? 'verified' : answer.code ?? answer.state,
  });
  return answer;
}

// A blocked request (unregistered or tampered) is never answered: we only note it in the history.
export async function recordBlocked(claimedBy: string, reason: string): Promise<void> {
  await addHistory({ at: new Date().toISOString(), verifierName: claimedBy, claims: [], decision: 'declined', outcome: `blocked: ${reason}` });
}
