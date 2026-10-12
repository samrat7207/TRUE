// Starts ONE verifier instance. The front door (proxy.ts) starts two of these:
//   instance 1 on port 4002, instance 2 on port 4012, each with its own database file.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { openVerifierDb } from './db.ts';
import { createVerifierApp } from './app.ts';
import { mergeState, type SharedState } from './sync.ts';

const INSTANCE = process.env.INSTANCE ?? '1';
const PORT = Number(process.env.PORT ?? 4002);
const PEER_URL = process.env.PEER_URL ?? ''; // the other instance, e.g. http://localhost:4012
const INTERNAL_KEY = process.env.INTERNAL_SYNC_KEY ?? '';

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

// Calls the other instance's /internal endpoints with the shared secret. Gives up after 1 second.
async function callPeer(path: string, body?: SharedState) {
  const response = await fetch(PEER_URL + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-internal-key': INTERNAL_KEY },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(1000),
  });
  if (!response.ok) throw new Error('peer refused');
  return response.json();
}

const db = openVerifierDb(fileURLToPath(new URL(`verifier-${INSTANCE}.db`, DATA_DIR)));
const app = createVerifierApp(db, getIssuerPublicJwk, {
  instance: INSTANCE,
  internalKey: INTERNAL_KEY,
  sendToPeer: PEER_URL ? (state) => callPeer('/internal/sync', state) : undefined,
});

// Catch up after a restart: copy whatever the other instance learned while we were down.
if (PEER_URL) {
  try {
    mergeState(db, await callPeer('/internal/state'));
    console.log(`Instance ${INSTANCE} caught up from its peer`);
  } catch {
    console.log(`Instance ${INSTANCE}: peer not reachable yet, starting with local state`);
  }
}

serve({ fetch: app.fetch, port: PORT }, () => console.log(`Verifier instance ${INSTANCE} listening on http://localhost:${PORT}`));
