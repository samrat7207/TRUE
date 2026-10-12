// Verifier database: this verifier's own config, requests and results.
// It is a separate file from the issuer database and holds no student records.
import { DatabaseSync } from 'node:sqlite';

export type VerifierRow = {
  id: string;
  name: string;
  purpose: string;
  allowed_claims_json: string; // JSON array of claim names this verifier may ask for
};

export type RequestRow = {
  id: string;
  verifier_id: string;
  claims_json: string;
  nonce: string;
  state: 'pending' | 'verified' | 'denied' | 'expired';
  created_at: string;
  expires_at: string;
  updated_at: string; // when the state last changed; used for "latest wins" when instances merge
  result_json: string | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS verifiers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  allowed_claims_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  verifier_id TEXT NOT NULL REFERENCES verifiers(id),
  claims_json TEXT NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  result_json TEXT
);
-- Cached revocation bits (one row). 1 = revoked.
CREATE TABLE IF NOT EXISTS status_list (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bits_hex TEXT NOT NULL
);
-- What happened, without personal data: only ids, types and times.
-- request_id is the subject of the event: a request id, or "source:<hash>" for a blocked caller.
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  request_id TEXT NOT NULL,
  instance TEXT NOT NULL
);
`;

// Demo verifiers. One process hosts all three to keep the demo to one command;
// in real life each would run its own copy of this service.
// registered: true means scripts/chain-setup.ts puts this verifier in the on-chain registry.
export const DEMO_VERIFIERS = [
  { id: 'verifier:city-library', name: 'City Library', purpose: 'Issue a library membership card', claims: ['name', 'photo', 'pnr'], registered: true },
  { id: 'verifier:nova-arena', name: 'Nova Arena', purpose: 'Entry to an 18+ event', claims: ['age_over_18'], registered: true },
  { id: 'verifier:campus-store', name: 'Campus Store', purpose: 'Student discount', claims: ['is_student'], registered: true },
  // The phishing demo: a verifier nobody registered. The wallet must warn about it.
  { id: 'verifier:free-prize-booth', name: 'Free Prize Booth', purpose: 'Win a free phone', claims: ['name', 'dob', 'address'], registered: false },
];

// Opens (and on first run creates and seeds) the verifier database. Use ':memory:' in tests.
export function openVerifierDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  // INSERT OR IGNORE: safe to run on every start, and adds new demo verifiers to an older database file.
  const insert = db.prepare('INSERT OR IGNORE INTO verifiers (id, name, purpose, allowed_claims_json) VALUES (?, ?, ?, ?)');
  for (const v of DEMO_VERIFIERS) insert.run(v.id, v.name, v.purpose, JSON.stringify(v.claims));
  return db;
}
