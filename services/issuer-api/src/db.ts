// Database of the core service: accounts, each institution's signing keys, and the credentials they issue.
// Uses node:sqlite, which is built into Node 24 (nothing to install).
import { DatabaseSync } from 'node:sqlite';

// A person or an institution. The password is stored only as a salted scrypt hash.
export type Account = {
  id: string; // "person:…" or "inst:…"
  kind: 'person' | 'institution';
  name: string;
  email: string; // lower case
  password_hash: string;
  category: string | null; // institutions: college | gym | company | other
  verified: number; // institutions: 1 once the operator ran "npm run verify-institution"
  created_at: string;
};

export type InstitutionKey = { institution_id: string; kid: string; public_jwk: string; private_jwk: string; state: 'Active' | 'Retired' | 'Compromised'; created_at: string };

// One row per credential an institution offered to a person.
// pending = offered; active = accepted and in the person's wallet; declined = the person said no;
// cancelled = the institution withdrew the offer; revoked = cancelled after it was accepted.
export type Credential = {
  id: string; // e.g. TR-0007
  institution_id: string;
  person_id: string;
  template: string; // StudentID | LibraryCard | GymMembership | EmployeeID
  fields_json: string; // the field values the institution typed in
  status: 'pending' | 'active' | 'declined' | 'cancelled' | 'revoked';
  claim_nonce: string; // the wallet signs this to prove it owns its key when it accepts
  created_at: string;
  claimed_at: string | null;
  status_list_index: number | null;
  revoked_reason: string | null;
  revoked_at: string | null;
};

// What happened and who did it. Account ids and credential ids only: never a name or an email.
export type AuditEvent = { id: number; ts: string; type: string; actor: string | null; institution_id: string | null; subject: string };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  category TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
-- Every institution has its own signing keys. The private half never leaves this database.
CREATE TABLE IF NOT EXISTS institution_keys (
  institution_id TEXT NOT NULL,
  kid TEXT NOT NULL,
  public_jwk TEXT NOT NULL,
  private_jwk TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (institution_id, kid)
);
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  template TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  status TEXT NOT NULL,
  claim_nonce TEXT NOT NULL,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  status_list_index INTEGER UNIQUE,
  revoked_reason TEXT,
  revoked_at TEXT
);
-- The revocation list (one row): one bit per credential, 1 = revoked. One list for all institutions
-- hosted here, so a position says nothing about which institution issued the credential.
CREATE TABLE IF NOT EXISTS status_list (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bits_hex TEXT NOT NULL,
  version INTEGER NOT NULL
);
INSERT OR IGNORE INTO status_list (id, bits_hex, version) VALUES (1, '', 0);
-- The key that signs session tokens (one row).
CREATE TABLE IF NOT EXISTS session_key (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  public_jwk TEXT NOT NULL,
  private_jwk TEXT NOT NULL
);
-- Audit log: ids only, never names or emails.
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT,
  institution_id TEXT,
  subject TEXT NOT NULL
);
`;

// Opens (and on first run creates) the database. Use ':memory:' in tests.
export function openCoreDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
