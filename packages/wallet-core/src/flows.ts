// The wallet's flows, with no user interface in them: claim a credential, read a verifier's request,
// answer it. Screens call these; tests call them too (with in-process servers instead of the network).
// All cryptography is done by packages/credentials.
import {
  authenticateRequest, createHolderProof, createPresentation, readCredential,
  type RequestCheck, type VerifierInfo,
} from '@true/credentials';
import {
  addCredential, addHistory, getCredentials, getHolderKey, getMyRequests, markRevoked, removeCredential, saveMyRequests,
  type MyRequest, type StoredCredential,
} from './storage.ts';

// How the wallet reaches servers. The browser passes window.fetch; tests pass a stand-in.
export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;

const postJson = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// ---------- what did the user scan or paste? ----------

export type Scanned =
  | { kind: 'present'; requestUri: string } // a verifier's request
  | { kind: 'claim'; code: string } // an issuer's credential offer
  | { kind: 'unknown' };

// Accepts a verifier link (…present?request_uri=…), an issuer offer link (…claim?code=…),
// a bare request address, or a bare 8-character claim code.
export function parseScanned(text: string): Scanned {
  const value = text.trim();
  const requestUri = /[?&]request_uri=([^&\s]+)/.exec(value);
  if (requestUri) return { kind: 'present', requestUri: decodeURIComponent(requestUri[1]) };
  const code = /[?&]code=([A-Za-z0-9]+)/.exec(value);
  if (code) return { kind: 'claim', code: code[1].toUpperCase() };
  if (/^https?:\/\/\S+\/v1\/requests\/[0-9a-f]+\/object$/.test(value)) return { kind: 'present', requestUri: value };
  if (/^[A-Za-z0-9]{8}$/.test(value)) return { kind: 'claim', code: value.toUpperCase() };
  return { kind: 'unknown' };
}

// ---------- claim ----------

// Swap a one-time claim code for a credential and store it. Throws an Error with the issuer's reason if refused.
export async function claimCredential(input: { code: string; issuerApi: string; fetch: Fetch }): Promise<StoredCredential> {
  const code = input.code.trim().toUpperCase();
  // 1. Ask the issuer for this code's nonce.
  const offerResponse = await input.fetch(`${input.issuerApi}/v1/claim-codes/${encodeURIComponent(code)}`);
  const offer = await offerResponse.json();
  if (!offerResponse.ok) throw new Error(offer.error.message);
  // 2. Prove we own our key by signing that nonce. The private key never leaves this device.
  const holder = await getHolderKey();
  const proof = await createHolderProof({
    holderPrivateKey: holder.privateKey, holderPublicJwk: holder.publicJwk, nonce: offer.nonce, audience: offer.issuerId,
  });
  // 3. Swap the code + proof for a signed credential.
  const response = await input.fetch(`${input.issuerApi}/v1/credentials`, postJson({ code, proof }));
  const result = await response.json();
  if (!response.ok) throw new Error(result.error.message);
  // A re-issued credential replaces any older card of the SAME TYPE for the same student,
  // so a stale card can never be presented by mistake. A Student ID and a Library Card sit side by side.
  const fresh = await readCredential(result.credential);
  for (const old of await getCredentials()) {
    const claims = await readCredential(old.credential);
    if (claims.pnr === fresh.pnr && claims.vct === fresh.vct) await removeCredential(old.id);
  }
  await addCredential(result.credential, result.issuerName);
  return (await getCredentials()).at(-1)!;
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

// ---------- asking an issuer for a credential (Requests tab) ----------

// Send a request to the issuer. Only the type, PNR and date of birth are sent; the date is not kept on the device.
export async function submitCredentialRequest(input: { type: string; pnr: string; dob: string; issuerApi: string; fetch: Fetch }): Promise<MyRequest> {
  const response = await input.fetch(`${input.issuerApi}/v1/credential-requests`, postJson({ type: input.type, pnr: input.pnr, dob: input.dob }));
  const body = await response.json();
  if (!response.ok) throw new Error(body.error.message);
  const request: MyRequest = { id: body.requestId, type: input.type, pnr: input.pnr.trim().toUpperCase(), createdAt: new Date().toISOString(), status: 'pending' };
  await saveMyRequests([request, ...(await getMyRequests())]);
  return request;
}

// Ask the issuer about every request that is still pending. When one was approved, collect the
// credential straight away with the claim code in the answer. Returns the up-to-date list.
export async function refreshCredentialRequests(input: { issuerApi: string; fetch: Fetch }): Promise<MyRequest[]> {
  const requests = await getMyRequests();
  let changed = false;
  for (const request of requests) {
    if (request.status !== 'pending') continue;
    const response = await input.fetch(`${input.issuerApi}/v1/credential-requests/${request.id}`).catch(() => null);
    if (!response?.ok) continue; // issuer not reachable right now: try again next time
    const answer = await response.json();
    if (answer.status === 'rejected') {
      request.status = 'rejected';
      changed = true;
    } else if (answer.status === 'approved') {
      try {
        await claimCredential({ code: answer.code, issuerApi: input.issuerApi, fetch: input.fetch });
        request.status = 'approved';
        request.note = 'Added to your wallet';
      } catch (e) {
        request.status = 'approved';
        request.note = `Approved, but it could not be collected: ${e instanceof Error ? e.message : 'unknown error'}`;
      }
      changed = true;
    }
  }
  if (changed) await saveMyRequests(requests);
  return requests;
}
