// Wipes all demo state: both databases, generated keys and the chain address file.
// The next "npm run dev" starts clean with the 8 fake students. Run with: npm run reset
// (Stop "npm run dev" first. Credentials already in a wallet stop verifying; remove them in the wallet.)
import { rmSync } from 'node:fs';

for (const folder of ['data', 'services/issuer-api/data', 'services/verifier-api/data']) {
  rmSync(folder, { recursive: true, force: true });
  console.log('removed', folder);
}
