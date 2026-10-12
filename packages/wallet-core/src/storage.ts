// Wallet storage. Everything stays in this browser (IndexedDB); nothing is sent to a server.
// IndexedDB is used instead of localStorage because it can store the non-exportable private key object.
import { generateHolderKey, type Jwk } from '@true/credentials';

export type HolderKey = { privateKey: CryptoKey; publicJwk: Jwk };
// revoked: set when a verifier told us the issuer has cancelled this card.
export type StoredCredential = { id: string; credential: string; issuerName: string; addedAt: string; revoked?: boolean };
export type HistoryEntry = { at: string; verifierName: string; claims: string[]; decision: 'shared' | 'declined'; outcome: string };
// Things the user can change on the Profile screen. Stored on the device like everything else.
export type Settings = { holderName: string; issuerApi: string };

// Tests run in Node, which has no IndexedDB: they switch the store to a plain in-memory Map.
let memory: Map<string, unknown> | null = null;
export function useMemoryStorage(): void {
  memory = new Map();
}

// One simple key-value store.
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('true-wallet', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function get<T>(key: string): Promise<T | undefined> {
  if (memory) return memory.get(key) as T | undefined;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction('kv').objectStore('kv').get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function set(key: string, value: unknown): Promise<void> {
  if (memory) return void memory.set(key, value);
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
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

export async function addCredential(credential: string, issuerName: string): Promise<void> {
  const list = await getCredentials();
  list.push({ id: crypto.randomUUID(), credential, issuerName, addedAt: new Date().toISOString() });
  await set('credentials', list);
}

// Which card to present: the most recently added one.
// (Bug fixed here: the wallet used to take the FIRST card, so an old card left in the wallet was
// presented instead of a freshly issued one.)
export function pickCredential<T extends { addedAt: string }>(cards: T[]): T | undefined {
  return [...cards].sort((a, b) => b.addedAt.localeCompare(a.addedAt))[0];
}

// Remember that the issuer has revoked this card, so the wallet can show it.
export async function markRevoked(id: string): Promise<void> {
  await set('credentials', (await getCredentials()).map((c) => (c.id === id ? { ...c, revoked: true } : c)));
}

// Which card answers THIS request: the newest card that holds every claim the verifier asks for.
// (A Library Card cannot answer "are you over 18?", so the Student ID is used for that.)
export function pickCredentialFor<T extends { addedAt: string; claims: Record<string, unknown> }>(cards: T[], requested: string[]): T | undefined {
  return pickCredential(cards.filter((card) => requested.every((claim) => claim in card.claims)));
}

export async function removeCredential(id: string): Promise<void> {
  await set('credentials', (await getCredentials()).filter((c) => c.id !== id));
}

// "Who asked what, when": kept only on the device.
export const getHistory = async () => (await get<HistoryEntry[]>('history')) ?? [];

export async function addHistory(entry: HistoryEntry): Promise<void> {
  await set('history', [entry, ...(await getHistory())]);
}

export const getSettings = async () => (await get<Partial<Settings>>('settings')) ?? {};

export async function saveSettings(settings: Partial<Settings>): Promise<void> {
  await set('settings', { ...(await getSettings()), ...settings });
}

// "Reset wallet": forget the key, every card, the history and the settings.
// The key cannot be recovered afterwards; credentials must be issued again.
export async function resetWallet(): Promise<void> {
  for (const key of ['holderKey', 'credentials', 'history', 'settings']) await set(key, undefined);
}
