// Starts ONE verifier instance. The front door (proxy.ts) starts several of these:
// instance N on port 4002, 4012, 4022, ... each with its own database file verifier-N.db.
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { ISSUER_ID, STATUS_LIST_URL } from '@true/shared';
import { sha256Hex } from '@true/credentials';
import { createRegistryReader, type ChainConfig } from '@true/registry';
import { openVerifierDb } from './db.ts';
import { createVerifierApp } from './app.ts';
import { getStatusBits, mergeState, refreshStatusList, type SharedState } from './sync.ts';

const INSTANCE = process.env.INSTANCE ?? '1';
const PORT = Number(process.env.PORT ?? 4002);
// The other instances, e.g. "http://localhost:4012,http://localhost:4022"
const PEER_URLS = (process.env.PEER_URLS ?? '').split(',').filter(Boolean);
const INTERNAL_KEY = process.env.INTERNAL_SYNC_KEY ?? '';
// How often to download the issuer's revocation list. Short for the demo; minutes or hours in real life.
const STATUS_REFRESH_SECONDS = Number(process.env.STATUS_REFRESH_SECONDS ?? 5);

// Private files of the verifier (its own database). Git-ignored.
const DATA_DIR = new URL('../data/', import.meta.url);
// Where the registry contract lives. Written by scripts/chain-setup.ts when "npm run dev" starts.
const CHAIN_FILE = new URL('../../../data/chain.json', import.meta.url);

mkdirSync(DATA_DIR, { recursive: true });

// Issuer keys and their state come from the chain, read fresh for every verification,
// so a key marked Compromised is rejected straight away.
const registry = createRegistryReader(JSON.parse(readFileSync(CHAIN_FILE, 'utf8')) as ChainConfig);
const getIssuerKey = (issuerId: string, keyId: string) => registry.getIssuerKey(issuerId, keyId);

// Calls one peer's /internal endpoint with the shared secret. Gives up after 1 second.
async function callPeer(peerUrl: string, path: string, body?: SharedState) {
  const response = await fetch(peerUrl + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-internal-key': INTERNAL_KEY },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(1000),
  });
  if (!response.ok) throw new Error('peer refused');
  return response.json();
}

// Send a change to ALL peers at once. Unreachable peers are ignored.
// Fails only if nobody received it, so "last synced" means at least one peer has our latest state.
async function sendToPeers(state: SharedState) {
  const results = await Promise.allSettled(PEER_URLS.map((peer) => callPeer(peer, '/internal/sync', state)));
  if (!results.some((result) => result.status === 'fulfilled')) throw new Error('no peer reachable');
}

const db = openVerifierDb(fileURLToPath(new URL(`verifier-${INSTANCE}.db`, DATA_DIR)));

// Catch up after a restart: pull the full state once from the first live peer.
// If no peer is alive we simply continue with what is in our own database file.
let caughtUp = false;
for (const peer of PEER_URLS) {
  try {
    mergeState(db, await callPeer(peer, '/internal/state'));
    caughtUp = true;
    console.log(`Instance ${INSTANCE} caught up from ${peer}`);
    break;
  } catch { /* try the next peer */ }
}
if (!caughtUp) console.log(`Instance ${INSTANCE}: no live peer, starting from its own database`);

const app = createVerifierApp(db, getIssuerKey, {
  instance: INSTANCE,
  internalKey: INTERNAL_KEY,
  sendToPeer: PEER_URLS.length ? sendToPeers : undefined,
  syncedAtStart: caughtUp,
});

// Revocation refresh on a schedule, never during a verification. The list is the same public file for
// everyone, it is accepted only if its fingerprint matches the chain, and new bits are shared with all peers.
setInterval(async () => {
  try {
    const outcome = await refreshStatusList(db, {
      fetchList: async () => (await fetch(STATUS_LIST_URL, { signal: AbortSignal.timeout(2000) })).json(),
      getAnchorHash: async () => (await registry.getStatusAnchor(ISSUER_ID)).hash,
      hash: sha256Hex,
    });
    if (outcome === 'updated') {
      console.log(`Instance ${INSTANCE}: revocation list updated`);
      if (PEER_URLS.length) await sendToPeers({ statusBitsHex: getStatusBits(db) }).catch(() => {});
    }
    if (outcome === 'mismatch') console.log(`Instance ${INSTANCE}: revocation list does not match the chain fingerprint, ignored`);
  } catch { /* issuer or chain not reachable right now: keep using the cached list */ }
}, STATUS_REFRESH_SECONDS * 1000);

serve({ fetch: app.fetch, port: PORT }, () => console.log(`Verifier instance ${INSTANCE} listening on http://localhost:${PORT}`));
