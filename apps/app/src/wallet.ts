// Glue between the screens and the real wallet logic (packages/wallet-core, packages/credentials).
// Nothing here is mock data: every value shown comes from the stored credential, the registry or a verifier.
import { useCallback, useEffect, useState } from 'react';
import { TEMPLATES } from '@true/shared';
import { inspectCredential, readCredential, type CardCheck } from '@true/credentials';
import { createRegistryReader, type IssuerInfo } from '@true/registry';
import { getCredentials, type Fetch, type StoredCredential } from '@true/wallet-core';
import { coreApi } from './server.ts';

// The app reads the public registry through the server's read-only /chain window (the chain node itself is
// not on the network). The contract address is asked for once per server address.
type Reader = ReturnType<typeof createRegistryReader>;
let cached: { server: string; reader: Promise<Reader> } | null = null;
function reader(): Promise<Reader> {
  const server = coreApi();
  if (cached?.server !== server) {
    const loading = fetch(`${server}/v1/chain`, { signal: AbortSignal.timeout(8000) })
      .then((response) => response.json())
      .then((body) => createRegistryReader({ rpcUrl: `${server}/chain`, address: body.address }));
    loading.catch(() => { cached = null; }); // not reachable: try again next time
    cached = { server, reader: loading };
  }
  return cached.reader;
}
// The same calls as before; each one waits for the reader above.
export const registry = {
  getIssuer: async (id: string) => (await reader()).getIssuer(id),
  listIssuers: async () => (await reader()).listIssuers(),
  getIssuerKey: async (issuerId: string, keyId: string) => (await reader()).getIssuerKey(issuerId, keyId),
  getVerifier: async (id: string) => (await reader()).getVerifier(id),
};

export const browserFetch: Fetch = (url, init) => fetch(url, init);

// The verifier's check names, in plain words (Verifying screen).
export const STEP_LABELS: Record<string, string> = {
  proof_integrity: 'Proof integrity',
  issuer_key_state: 'Issuer key is registered and not compromised',
  issuer_signature: 'Issuer signature',
  holder_and_audience: 'Proof is yours and made for this verifier',
  freshness: 'Freshness (one-time request, recent)',
  revocation_status: 'Revocation status',
  required_claims: 'Required fields, institution and ID type',
};

export const formatDate = (seconds: number) => new Date(seconds * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

// ---------- cards ----------

// One stored credential with everything the screens need.
export type CardView = {
  stored: StoredCredential;
  claims: Record<string, unknown>; // every field inside the card, plus vct (its type)
  type: string;
  // From the chain. null = the registry could not be reached, so the card could not be checked right now.
  check: CardCheck | null;
  issuer: IssuerInfo | null; // the institution's name and verified flag as the registry has them
};

// Badge text and colour for a card. "Verified" means: the institution's signature checks out against
// its key in the on-chain registry, the key is not compromised, and no verifier has reported it revoked.
export function cardStatus(card: CardView): { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' } {
  if (card.stored.revoked) return { label: 'Revoked', tone: 'bad' };
  if (!card.check) return { label: 'Not checked', tone: 'neutral' };
  switch (card.check.status) {
    case 'verified': return { label: 'Verified', tone: 'ok' };
    case 'key_compromised': return { label: 'Issuer key compromised', tone: 'bad' };
    case 'expired': return { label: 'Expired', tone: 'warn' };
    case 'unknown_issuer': return { label: 'Issuer not in registry', tone: 'warn' };
    default: return { label: 'Signature invalid', tone: 'bad' };
  }
}

async function loadCard(stored: StoredCredential): Promise<CardView> {
  const claims = await readCredential(stored.credential);
  const check = await inspectCredential(stored.credential, (issuer, keyId) => registry.getIssuerKey(issuer, keyId)).catch(() => null);
  const issuer = await registry.getIssuer(stored.issuerId).catch(() => null);
  return { stored, claims, type: String(claims.vct), check, issuer };
}

// All cards in the logged-in person's wallet, newest first. `cards` is null while loading.
export function useCards() {
  const [cards, setCards] = useState<CardView[] | null>(null);
  const reload = useCallback(async () => {
    const views = await Promise.all((await getCredentials()).map(loadCard));
    setCards(views.sort((a, b) => b.stored.addedAt.localeCompare(a.stored.addedAt)));
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { cards, reload };
}

// The field names inside a card, in the order of its template (technical entries left out).
const TECHNICAL = ['iss', 'iat', 'exp', 'vct', 'cnf', 'revocation'];
export function cardFields(claims: Record<string, unknown>): string[] {
  const order = TEMPLATES[String(claims.vct)]?.fields ?? [];
  const position = (name: string) => (order.includes(name) ? order.indexOf(name) : order.length);
  return Object.keys(claims).filter((name) => !TECHNICAL.includes(name)).sort((a, b) => position(a) - position(b));
}
