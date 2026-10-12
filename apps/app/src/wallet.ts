// Glue between the screens and the real wallet logic (packages/wallet-core, packages/credentials).
// Nothing here is mock data: every value shown comes from the stored credential, the registry or a verifier.
import { useCallback, useEffect, useState } from 'react';
import { CREDENTIAL_TYPES, URLS } from '@true/shared';
import { inspectCredential, readCredential, type CardCheck } from '@true/credentials';
import { createRegistryReader } from '@true/registry';
import { getCredentials, getSettings, type Fetch, type StoredCredential } from '@true/wallet-core';

// The registry contract address is filled in by vite.config.ts from data/chain.json.
declare const __REGISTRY_ADDRESS__: `0x${string}`;
// The app reads the public registry straight from the chain node, through the dev server's /chain path.
export const registry = createRegistryReader({ rpcUrl: window.location.origin + '/chain', address: __REGISTRY_ADDRESS__ });

export const browserFetch: Fetch = (url, init) => fetch(url, init);

// Issuer API address: the one saved on the Profile screen, or the default.
export const issuerApiAddress = async () => (await getSettings()).issuerApi || URLS.issuerApi;

// ---------- words shown to the user ----------

export const TYPE_LABELS: Record<string, string> = CREDENTIAL_TYPES;

// What sharing each claim means, in plain words (consent screen).
export const CLAIM_HELP: Record<string, string> = {
  name: 'Your full name',
  pnr: 'Your student number',
  dob: 'Your exact date of birth',
  address: 'Your home address',
  class: 'Your class',
  section: 'Your section',
  branch: 'Your branch of study',
  photo: 'Your ID photo',
  institution: 'The institution you study at',
  is_student: 'Proves you are a current student, nothing else',
  age_over_18: 'Proves you are 18 or older, without your date of birth',
  library_member: 'Proves you are a library member',
};

// The verifier's check names, in plain words (Verifying screen).
export const STEP_LABELS: Record<string, string> = {
  proof_integrity: 'Proof integrity',
  issuer_key_state: 'Issuer key is registered and not compromised',
  issuer_signature: 'Issuer signature',
  holder_and_audience: 'Proof is yours and made for this verifier',
  freshness: 'Freshness (one-time request, recent)',
  revocation_status: 'Revocation status',
  required_claims: 'Required claims',
};

// How a claim value is written on screen. Photos are never drawn.
export function displayValue(name: string, value: unknown): string {
  if (name === 'photo') return 'ID photo (never displayed in this app)';
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  return String(value ?? '');
}

export const formatDate = (seconds: number) => new Date(seconds * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

// ---------- cards ----------

// One stored credential with everything the screens need.
export type CardView = {
  stored: StoredCredential;
  claims: Record<string, unknown>;
  // null = the registry could not be reached, so the card could not be checked right now.
  check: CardCheck | null;
};

// Badge text and colour for a card. "Verified" means: the issuer's signature checks out against
// the key in the on-chain registry, the key is not compromised, and no verifier has reported it revoked.
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
  return { stored, claims, check };
}

// All cards in the wallet, newest first. `cards` is null while loading.
export function useCards() {
  const [cards, setCards] = useState<CardView[] | null>(null);
  const reload = useCallback(async () => {
    const stored = await getCredentials();
    const views = await Promise.all(stored.map(loadCard));
    setCards(views.sort((a, b) => b.stored.addedAt.localeCompare(a.stored.addedAt)));
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { cards, reload };
}

// The name to greet: the one typed on the Profile screen, else the name inside the newest credential.
export function useHolderName(cards: CardView[] | null): string {
  const [saved, setSaved] = useState('');
  useEffect(() => { getSettings().then((s) => setSaved(s.holderName ?? '')); }, []);
  return saved || String(cards?.[0]?.claims.name ?? '');
}
