// Starts the issuer API on port 4001.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { ISSUER_ID } from '@true/shared';
import { generateSigningKeyPair } from '@true/credentials';
import type { StaffRole } from './db.ts';
import { createRegistryReader, createRegistryWriter, type ChainConfig } from '@true/registry';
import { openIssuerDb, type IssuerKeyRow } from './db.ts';
import { createIssuerApp, statusListHash, type IssuerChain } from './app.ts';

// Private files of the issuer (database, which also holds the signing keys). Git-ignored.
const DATA_DIR = new URL('../data/', import.meta.url);
// Where the registry contract lives. Written by scripts/chain-setup.ts when "npm run dev" starts.
const CHAIN_FILE = new URL('../../../data/chain.json', import.meta.url);

mkdirSync(DATA_DIR, { recursive: true });
const db = openIssuerDb(fileURLToPath(new URL('issuer.db', DATA_DIR)));

// The issuer writes to the chain from its own admin account: only that account may change this issuer's entries.
const config: ChainConfig = JSON.parse(readFileSync(CHAIN_FILE, 'utf8'));
const reader = createRegistryReader(config);
const writer = createRegistryWriter(config, config.issuerAdmin);
const chain: IssuerChain = {
  addIssuerKey: (keyId, publicJwk) => writer.addIssuerKey(ISSUER_ID, keyId, publicJwk),
  setIssuerKeyState: (keyId, state) => writer.setIssuerKeyState(ISSUER_ID, keyId, state),
  anchorStatusList: (hashHex, version) => writer.anchorStatusList(ISSUER_ID, hashHex, version),
};

// The four demo staff. Their PINs come from .env (STAFF_PIN_ADMIN and so on) and are never in the code.
// If a PIN is missing we make a random 6-digit one and append it to .env, so the demo still starts
// and you can read the PIN there. Used only when the staff table is empty.
const ENV_FILE = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const DEMO_STAFF: { id: string; name: string; role: StaffRole }[] = [
  { id: 'S-001', name: 'Priya Nair', role: 'admin' },
  { id: 'S-002', name: 'Arjun Rao', role: 'issuer' },
  { id: 'S-003', name: 'Kavya Menon', role: 'revoker' },
  { id: 'S-004', name: 'Rahul Iyer', role: 'auditor' },
];
const seedStaff = DEMO_STAFF.map((person) => {
  const variable = `STAFF_PIN_${person.role.toUpperCase()}`;
  let pin = process.env[variable];
  if (!pin) {
    pin = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    appendFileSync(ENV_FILE, `\n${variable}=${pin}`);
    console.log(`No ${variable} in .env: a random demo PIN was written there`);
  }
  return { ...person, pin };
});

// A first key is only used if the database has none yet.
const app = createIssuerApp(db, await generateSigningKeyPair(), chain, {
  seedStaff,
  getSource: (c) => getConnInfo(c).remote.address ?? 'unknown', // the caller's IP address, for rate limiting
});

// The local chain starts empty on every run, but our database persists. So on start-up we publish
// whatever the chain is missing: every public key with its state, and the revocation list fingerprint.
for (const key of db.prepare('SELECT * FROM issuer_keys ORDER BY created_at, kid').all() as IssuerKeyRow[]) {
  const onChain = await reader.getIssuerKey(ISSUER_ID, key.kid);
  if (!onChain) await chain.addIssuerKey(key.kid, JSON.parse(key.public_jwk));
  if (key.state !== 'Active' && onChain?.state !== key.state) await chain.setIssuerKeyState(key.kid, key.state);
}
const list = db.prepare('SELECT bits_hex, version FROM status_list WHERE id = 1').get() as { bits_hex: string; version: number };
if (list.version === 0) {
  // First ever start: publish the empty list as version 1 so verifiers have something to compare against.
  list.version = 1;
  db.prepare('UPDATE status_list SET version = 1 WHERE id = 1').run();
}
if ((await reader.getStatusAnchor(ISSUER_ID)).version < list.version) {
  await chain.anchorStatusList(statusListHash(list.bits_hex), list.version);
}
console.log('Issuer keys and revocation fingerprint are on the chain');

serve({ fetch: app.fetch, port: 4001 }, () => console.log('Issuer API listening on http://localhost:4001'));
