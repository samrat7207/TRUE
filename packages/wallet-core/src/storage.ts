// Wallet storage. Everything stays in this browser (IndexedDB); nothing here is sent to a server.
// IndexedDB is used instead of localStorage because it can store the non-exportable private key object.
// Each account has its own wallet on the device: every entry is stored under that account's id.
import { generateHolderKey, type Jwk } from '@true/credentials';

export type HolderKey = { privateKey: CryptoKey; publicJwk: Jwk };
// revoked: set when a verifier told us the issuer has cancelled this card.
export type StoredCredential = { id: string; credential: string; issuerId: string; issuerName: string; addedAt: string; revoked?: boolean };
export type HistoryEntry = { at: string; verifierName: string; claims: string[]; decision: 'shared' | 'declined'; outcome: string };

// Tests run in Node, which has no IndexedDB: they switch the store to a plain in-memory Map.
let memory: Map<string, unknown> | null = null;
export function useMemoryStorage(): void {
  memory = new Map();
}

// Whose wallet is open. Set when someone logs in; every read and write below is for this account only.
let owner = 'nobody';
export function setWalletOwner(accountId: string): void {
  owner = accountId;
}
const keyFor = (name: string) => `${owner}/${name}`;

// One simple key-value store.
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('true-wallet', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function get<T>(name: string): Promise<T | undefined> {
  if (memory) return memory.get(keyFor(name)) as T | undefined;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction('kv').objectStore('kv').get(keyFor(name));
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function set(name: string, value: unknown): Promise<void> {
  if (memory) return void memory.set(keyFor(name), value);
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, keyFor(name));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// The wallet's key pair. Created on this device the first time it is needed, then reused.
export async function getHolderKey(): Promise<HolderKey> {
  const existing = await get<HolderKey>('holderKey');
  if (existing) return existing;
  const created = await generateHolderKey();
  await set('holderKey', created);
  return created;
}

export const getCredentials = async () => (await get<StoredCredential[]>('credentials')) ?? [];

export async function addCredential(card: Omit<StoredCredential, 'addedAt'>): Promise<void> {
  const list = (await getCredentials()).filter((c) => c.id !== card.id);
  list.push({ ...card, addedAt: new Date().toISOString() });
  await set('credentials', list);
}

// The newest of these cards.
export function pickCredential<T extends { addedAt: string }>(cards: T[]): T | undefined {
  return [...cards].sort((a, b) => b.addedAt.localeCompare(a.addedAt))[0];
}

// Which cards can answer a request: they must hold every requested claim and, when the verifier is pinned
// to one institution and one credential type, be exactly that. Newest first.
export function matchingCredentials<T extends { addedAt: string; issuerId: string; claims: Record<string, unknown> }>(
  cards: T[], requested: string[], pin?: { issuer?: string; type?: string },
): T[] {
  return cards
    .filter((card) => requested.every((claim) => claim in card.claims))
    .filter((card) => !pin?.issuer || (card.issuerId === pin.issuer && card.claims.vct === pin.type))
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

// Remember that the issuer has revoked this card, so the wallet can show it.
export async function markRevoked(id: string): Promise<void> {
  await set('credentials', (await getCredentials()).map((c) => (c.id === id ? { ...c, revoked: true } : c)));
}

export async function removeCredential(id: string): Promise<void> {
  await set('credentials', (await getCredentials()).filter((c) => c.id !== id));
}

// "Who asked what, when": kept only on the device.
export const getHistory = async () => (await get<HistoryEntry[]>('history')) ?? [];

export async function addHistory(entry: HistoryEntry): Promise<void> {
  await set('history', [entry, ...(await getHistory())]);
}

// Clear this account's wallet on this device: the key, every card and the history.
// The key cannot be recovered afterwards; credentials must be issued again.
export async function resetWallet(): Promise<void> {
  for (const name of ['holderKey', 'credentials', 'history']) await set(name, undefined);
}
