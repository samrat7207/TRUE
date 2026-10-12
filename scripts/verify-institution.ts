// Operator command: mark an institution as verified.   npm run verify-institution -- <email>
// New institution sign-ups are "Unverified" until this is run. It updates the core database and the
// registry on the chain (as the registry owner), so every app can read the flag from the chain.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRegistryWriter, type ChainConfig } from '@true/registry';
import { openCoreDb } from '../services/issuer-api/src/db.ts';
import { verifyInstitution } from '../services/issuer-api/src/app.ts';

const email = process.argv[2];
const dbFile = fileURLToPath(new URL('../services/issuer-api/data/core.db', import.meta.url));
const chainFile = new URL('../data/chain.json', import.meta.url);
if (!email || !existsSync(dbFile) || !existsSync(chainFile)) {
  console.error('Usage: npm run verify-institution -- <email>   (run "npm run dev" first so the database and chain exist)');
  process.exit(1);
}

const config: ChainConfig = JSON.parse(readFileSync(chainFile, 'utf8'));
const asOwner = createRegistryWriter(config, config.owner);
const id = await verifyInstitution(openCoreDb(dbFile), email, (institutionId) => asOwner.setIssuerVerified(institutionId, true));
console.log(id ? `Verified ${email} (${id}). The app shows it within a few seconds.` : `No institution account has the email ${email}`);
process.exit(id ? 0 : 1);
