// Starts ONE verifier instance. The front door (proxy.ts) starts several of these:
// instance N on port 4002, 4012, 4022, ... each with its own database file verifier-N.db.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { URLS } from '@true/shared';
import { openVerifierDb } from './db.ts';
import { createVerifierApp } from './app.ts';
import { mergeState, type SharedState } from './sync.ts';

const INSTANCE = process.env.INSTANCE ?? '1';
const PORT = Number(process.env.PORT ?? 4002);
// The other instances, e.g. "http://localhost:4012,http://localhost:4022"
const PEER_URLS = (process.env.PEER_URLS ?? '').split(',').filter(Boolean);
const INTERNAL_KEY = process.env.INTERNAL_SYNC_KEY ?? '';
// Partner access, both from .env: the API key, and the partner's web origin(s) for CORS (comma separated).
const PARTNER_API_KEY = process.env.PARTNER_API_KEY || undefined;
const PARTNER_ORIGINS = (process.env.PARTNER_ORIGIN ?? '').split(',').filter(Boolean);

// Private files of the verifier (its own database). Git-ignored.
const DATA_DIR = new URL('../data/', import.meta.url);
// Public registry file. Stand-in for the chain until M2: it holds ONLY public keys.
const REGISTRY_FILE = new URL('../../../data/registry.json', import.meta.url);

mkdirSync(DATA_DIR, { recursive: true });

// Read the registry each time, so a key published after we started is still found.
function getIssuerPublicJwk(issuerId: string) {
  if (!existsSync(REGISTRY_FILE)) return null;
  const registry = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'));
  return registry.issuers?.[issuerId]?.publicJwk ?? null;
}

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

const app = createVerifierApp(db, getIssuerPublicJwk, {
  instance: INSTANCE,
  internalKey: INTERNAL_KEY,
  sendToPeer: PEER_URLS.length ? sendToPeers : undefined,
  syncedAtStart: caughtUp,
  apiKey: PARTNER_API_KEY,
  allowedOrigins: [URLS.wallet, URLS.verifierWeb, ...PARTNER_ORIGINS],
});

serve({ fetch: app.fetch, port: PORT }, () => console.log(`Verifier instance ${INSTANCE} listening on http://localhost:${PORT}`));
