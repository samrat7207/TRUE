// Starts the issuer API on port 4001.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { ISSUER_ID, ISSUER_NAME } from '@true/shared';
import { generateSigningKeyPair } from '@true/credentials';
import { openIssuerDb } from './db.ts';
import { createIssuerApp, type IssuerKeys } from './app.ts';

// Private files of the issuer (database + signing key). Git-ignored.
const DATA_DIR = new URL('../data/', import.meta.url);
// Public registry file. Stand-in for the chain until M2: it holds ONLY public keys.
const REGISTRY_FILE = new URL('../../../data/registry.json', import.meta.url);

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(new URL('./', REGISTRY_FILE), { recursive: true });

// Load the issuer signing key, or create it on first run.
const keyFile = new URL('issuer-key.json', DATA_DIR);
let keys: IssuerKeys;
if (existsSync(keyFile)) {
  keys = JSON.parse(readFileSync(keyFile, 'utf8'));
} else {
  keys = await generateSigningKeyPair();
  writeFileSync(keyFile, JSON.stringify(keys, null, 2));
}

// Publish the PUBLIC key to the registry so verifiers can check signatures without calling us.
const registry = existsSync(REGISTRY_FILE) ? JSON.parse(readFileSync(REGISTRY_FILE, 'utf8')) : { issuers: {} };
registry.issuers[ISSUER_ID] = { name: ISSUER_NAME, publicJwk: keys.publicJwk };
writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));

const db = openIssuerDb(fileURLToPath(new URL('issuer.db', DATA_DIR)));
const app = createIssuerApp(db, keys);

serve({ fetch: app.fetch, port: 4001 }, () => console.log('Issuer API listening on http://localhost:4001'));
