// Starts the core API on port 4001: accounts, institutions, issuing and offers.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { CHAIN_RPC_URL, STATUS_LIST_ID } from '@true/shared';
import { createRegistryReader, createRegistryWriter, type ChainConfig } from '@true/registry';
import { openCoreDb } from './db.ts';
import { createCoreApp, type CoreChain, type SeedAccount } from './app.ts';

// Private files of this service (the database, which also holds every institution's signing key). Git-ignored.
const DATA_DIR = new URL('../data/', import.meta.url);
// Where the registry contract lives. Written by scripts/chain-setup.ts when "npm run dev" starts.
const CHAIN_FILE = new URL('../../../data/chain.json', import.meta.url);
// The PUBLIC key that checks session tokens. The verifier servers read this file, so they never call us.
const SESSION_KEY_FILE = new URL('../../../data/session-public-key.json', import.meta.url);

mkdirSync(DATA_DIR, { recursive: true });
const db = openCoreDb(fileURLToPath(new URL('core.db', DATA_DIR)));

// Two chain accounts: the registry owner adds institutions and marks them verified;
// the issuing service's own account publishes institution keys and the revocation fingerprint.
const config: ChainConfig = JSON.parse(readFileSync(CHAIN_FILE, 'utf8'));
const reader = createRegistryReader(config);
const asOwner = createRegistryWriter(config, config.owner);
const asService = createRegistryWriter(config, config.issuerAdmin);
const chain: CoreChain = {
  registerInstitution: (id, name) => asOwner.registerIssuer(id, name, config.issuerAdmin),
  setVerified: (id, verified) => asOwner.setIssuerVerified(id, verified),
  addIssuerKey: (id, keyId, publicJwk) => asService.addIssuerKey(id, keyId, publicJwk),
  setIssuerKeyState: (id, keyId, state) => asService.setIssuerKeyState(id, keyId, state),
  anchorStatusList: (hashHex, version) => asService.anchorStatusList(STATUS_LIST_ID, hashHex, version),
};

// Demo accounts. Their passwords come from .env and are never in the code. If one is missing we make a
// random password and append it to .env, so the demo still starts and you can read it there.
const ENV_FILE = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
function demoPassword(variable: string): string {
  if (!process.env[variable]) {
    process.env[variable] = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
    appendFileSync(ENV_FILE, `\n${variable}=${process.env[variable]}`);
    console.log(`No ${variable} in .env: a random demo password was written there`);
  }
  return process.env[variable]!;
}
const institutionPassword = demoPassword('DEMO_PASSWORD_INSTITUTIONS');
const personPassword = demoPassword('DEMO_PASSWORD_PEOPLE');
const seedAccounts: SeedAccount[] = [
  { kind: 'institution', name: 'Astra Institute of Technology', email: 'astra@demo.true', category: 'college', verified: true, password: institutionPassword },
  { kind: 'institution', name: 'IronWorks Gym', email: 'ironworks@demo.true', category: 'gym', verified: true, password: institutionPassword },
  { kind: 'institution', name: 'Nimbus Labs', email: 'nimbus@demo.true', category: 'company', verified: true, password: institutionPassword },
  { kind: 'person', name: 'Aarav Deshmukh', email: 'aarav@demo.true', password: personPassword },
  { kind: 'person', name: 'Isha Kulkarni', email: 'isha@demo.true', password: personPassword },
  { kind: 'person', name: 'Kabir Shaikh', email: 'kabir@demo.true', password: personPassword },
];

const { app, publishToChain, sessionPublicJwk } = await createCoreApp(db, chain, {
  seedAccounts,
  getSource: (c) => getConnInfo(c).remote.address ?? 'unknown', // the caller's IP address, for rate limiting
});
writeFileSync(SESSION_KEY_FILE, JSON.stringify(sessionPublicJwk));

// The local chain starts empty on every run: publish every institution, key, verified flag and the list fingerprint again.
await publishToChain(
  async (institutionId, keyId) => (await reader.getIssuerKey(institutionId, keyId))?.state ?? null,
  (await reader.getStatusAnchor(STATUS_LIST_ID)).version,
);
console.log('Institutions, keys and the revocation fingerprint are on the chain');

// ---------- the registry, for apps that cannot reach the chain node themselves (phones on the Wi-Fi) ----------
// The chain node stays on this machine only: its test accounts are unlocked, so it must not be on the network.
// Apps get the contract address here, and may send READ-ONLY calls through /chain. Nothing that changes the chain passes.
const READ_ONLY_METHODS = ['eth_call', 'eth_chainId', 'eth_blockNumber', 'eth_getCode'];
app.get('/v1/chain', (c) => c.json({ address: config.address }));
app.post('/chain', async (c) => {
  const body = await c.req.json().catch(() => null);
  const calls = Array.isArray(body) ? body : [body];
  if (!body || calls.some((call) => !READ_ONLY_METHODS.includes(call?.method))) {
    return c.json({ error: { code: 'read_only', message: 'Only read-only registry calls are allowed here' } }, 403);
  }
  const answer = await fetch(CHAIN_RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return c.json(await answer.json());
});

serve({ fetch: app.fetch, port: 4001 }, () => console.log('Core API listening on http://localhost:4001'));
