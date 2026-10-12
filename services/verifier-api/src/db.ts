// Verifier database: this verifier's own config, requests and results.
// It is a separate file from the issuer database and holds no student records.
import { DatabaseSync } from 'node:sqlite';
import { LOAD_TEST_VERIFIER_ID, REGISTER_SERVICE_ID, TEMPLATES } from '@true/shared';

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
  register_id: string | null; // set when the request was made from a register
};

// A register: a person's saved "check" that accepts ONE institution's ONE ID type and asks for chosen fields.
// deleted = 1 is kept as a marker so the deletion reaches every instance through sync.
export type RegisterRow = {
  id: string; owner_id: string; owner_name: string; name: string; purpose: string;
  issuer_id: string; issuer_name: string; type: string; fields_json: string;
  created_at: string; updated_at: string; deleted: number;
};

// One successful check through a register. It keeps ONLY the fields that register asked for and the holder
// agreed to share. The credential's revocation position and key id are kept so its status can be looked up live.
export type VisitRow = {
  id: string; register_id: string; credential_id: string; // credential_id: an opaque fingerprint, the same for every visit with one credential
  issuer: string; key_id: string; status_index: number; type: string; fields_json: string; verified_at: string; instance: string;
};
// A refused check through a register: the reason code and the time, nothing about the person or the credential.
export type DenialRow = { id: string; register_id: string; code: string; at: string };

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
CREATE TABLE IF NOT EXISTS registers (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  issuer_id TEXT NOT NULL,
  issuer_name TEXT NOT NULL,
  type TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS visits (
  id TEXT PRIMARY KEY,
  register_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  key_id TEXT NOT NULL,
  status_index INTEGER NOT NULL,
  type TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  instance TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS register_denials (
  id TEXT PRIMARY KEY,
  register_id TEXT NOT NULL,
  code TEXT NOT NULL,
  at TEXT NOT NULL
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
  { id: 'verifier:city-library', name: 'City Library', purpose: 'Issue a library membership card', claims: ['name', 'id_number'], registered: true },
  { id: 'verifier:nova-arena', name: 'Nova Arena', purpose: 'Entry to an 18+ event', claims: ['dob'], registered: true },
  { id: 'verifier:campus-store', name: 'Campus Store', purpose: 'Student discount', claims: ['name'], registered: true },
  // The phishing demo: a verifier nobody registered. The wallet must warn about it.
  { id: 'verifier:free-prize-booth', name: 'Free Prize Booth', purpose: 'Win a free phone', claims: ['name', 'dob', 'address'], registered: false },
  // Synthetic verifier used only by the load test button. Not registered, never shown as a verifier card.
  // The verifier service itself: signs the requests of every register. It may ask for any template field;
  // each register narrows that down to its own fields, institution and ID type.
  { id: REGISTER_SERVICE_ID, name: 'TRUE registers', purpose: 'Registers created by people', claims: [...new Set(Object.values(TEMPLATES).flatMap((t) => t.fields))], registered: true },
  { id: LOAD_TEST_VERIFIER_ID, name: 'Load test (synthetic)', purpose: 'Synthetic load test', claims: ['name'], registered: false },
];

// Opens (and on first run creates and seeds) the verifier database. Use ':memory:' in tests.
export function openVerifierDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  // Older database files do not have this column yet.
  try { db.exec('ALTER TABLE requests ADD COLUMN register_id TEXT'); } catch { /* already there */ }
  // INSERT OR IGNORE: safe to run on every start, and adds new demo verifiers to an older database file.
  const insert = db.prepare('INSERT OR IGNORE INTO verifiers (id, name, purpose, allowed_claims_json) VALUES (?, ?, ?, ?)');
  for (const v of DEMO_VERIFIERS) insert.run(v.id, v.name, v.purpose, JSON.stringify(v.claims));
  return db;
}
