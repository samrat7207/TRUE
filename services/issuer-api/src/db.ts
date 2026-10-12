// Issuer database: the source of truth for who may receive a credential.
// Uses node:sqlite, which is built into Node 24 (nothing to install).
import { DatabaseSync } from 'node:sqlite';

export type Student = {
  id: number;
  name: string;
  pnr: string;
  dob: string; // YYYY-MM-DD
  address: string;
  class: string;
  section: string;
  branch: string;
  photo: string; // small SVG data URI, stored here and in the wallet only
  status: 'active' | 'revoked';
  revoked_reason: string | null;
  status_list_index: number | null;
  created_at: string;
};

export type ClaimCode = {
  code: string;
  student_id: number;
  nonce: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
};

export type StaffRole = 'admin' | 'issuer' | 'revoker' | 'auditor';
export type StaffRow = { id: string; name: string; role: StaffRole; pin_hash: string; active: number; created_at: string };

// One row per credential the issuer has offered. This is the issuer's registry.
// status: pending = claim code created, not collected yet; active = collected; revoked = cancelled;
// replaced = the same student collected a newer one of the same type.
export type CredentialRow = {
  id: string; // e.g. TR-SID-0007
  student_id: number;
  type: string; // StudentCredential | LibraryCard
  status: 'pending' | 'active' | 'revoked' | 'replaced';
  claim_code: string;
  valid_from: string;
  valid_till: string;
  issued_by: string | null; // staff id
  created_at: string;
  claimed_at: string | null;
  status_list_index: number | null;
  revoked_reason: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
};

// What happened, by whom. Identifiers only: staff id and a credential / key / request id. Never a name.
export type AuditRow = { id: number; ts: string; type: string; staff_id: string | null; subject: string };

// A holder asking for a credential from their phone (Requests tab).
export type CredentialRequestRow = {
  id: string; // long random id, known only to the holder's app
  type: string;
  pnr: string;
  student_id: number | null; // set if the PNR exists
  dob_matches: number; // 1 if the date of birth typed by the holder equals our record. The typed date is not stored.
  status: 'pending' | 'approved' | 'rejected';
  claim_code: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
};

export type IssuerKeyRow = { kid: string; public_jwk: string; private_jwk: string; state: 'Active' | 'Retired' | 'Compromised'; created_at: string };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  pnr TEXT NOT NULL UNIQUE,
  dob TEXT NOT NULL,
  address TEXT NOT NULL,
  class TEXT NOT NULL,
  section TEXT NOT NULL,
  branch TEXT NOT NULL,
  photo TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  revoked_reason TEXT,
  status_list_index INTEGER UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS claim_codes (
  code TEXT PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  nonce TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
-- Signing keys. Exactly one is Active. The private half never leaves this database.
CREATE TABLE IF NOT EXISTS issuer_keys (
  kid TEXT PRIMARY KEY,
  public_jwk TEXT NOT NULL,
  private_jwk TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- The revocation list (one row): one bit per credential, 1 = revoked. Version goes up on every change.
CREATE TABLE IF NOT EXISTS status_list (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bits_hex TEXT NOT NULL,
  version INTEGER NOT NULL
);
INSERT OR IGNORE INTO status_list (id, bits_hex, version) VALUES (1, '', 0);
-- Staff who may use the issuer console. The PIN is stored only as a salted scrypt hash.
CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
-- The issuer's registry of credentials (see CredentialRow).
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  claim_code TEXT NOT NULL UNIQUE,
  valid_from TEXT NOT NULL,
  valid_till TEXT NOT NULL,
  issued_by TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  status_list_index INTEGER UNIQUE,
  revoked_reason TEXT,
  revoked_at TEXT,
  revoked_by TEXT
);
-- Audit log: identifiers only, never names.
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  staff_id TEXT,
  subject TEXT NOT NULL
);
-- Requests sent by holders from their phone.
CREATE TABLE IF NOT EXISTS credential_requests (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  pnr TEXT NOT NULL,
  student_id INTEGER,
  dob_matches INTEGER NOT NULL,
  status TEXT NOT NULL,
  claim_code TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);
-- List positions that belonged to a revoked credential. They are never handed out again,
-- because a revoked bit can never be turned back to 0.
CREATE TABLE IF NOT EXISTS retired_indexes (
  idx INTEGER PRIMARY KEY
);
`;

// All demo students are invented. No real person's data is used.
const FAKE_STUDENTS = [
  ['Aarav Deshmukh', 'AIT2023001', '2005-03-14', '12 Lake View Road, Pune', 'TE', 'A', 'Computer Engineering'],
  ['Isha Kulkarni', 'AIT2023002', '2004-11-02', '7 Hill Crest Lane, Pune', 'TE', 'A', 'Computer Engineering'],
  ['Rohan Patil', 'AIT2024003', '2009-06-21', '45 Station Road, Nashik', 'FE', 'B', 'Information Technology'],
  ['Meera Joshi', 'AIT2022004', '2003-01-30', '3 Garden Street, Mumbai', 'BE', 'C', 'Electronics'],
  ['Kabir Shaikh', 'AIT2023005', '2005-09-09', '88 Market Yard, Solapur', 'TE', 'B', 'Mechanical'],
  ['Ananya Rao', 'AIT2024006', '2006-12-25', '19 Temple Road, Kolhapur', 'SE', 'A', 'Computer Engineering'],
  ['Dev Mehta', 'AIT2022007', '2003-07-07', '60 Riverside Colony, Nagpur', 'BE', 'A', 'Civil'],
  ['Sara Fernandes', 'AIT2024008', '2009-02-18', '5 Church Street, Panaji', 'FE', 'C', 'Information Technology'],
];

// Placeholder photo: the student's initials on a coloured square. Drawn by us, so no third-party image.
function placeholderPhoto(name: string, index: number): string {
  const initials = name.split(' ').map((part) => part[0]).join('');
  const hue = (index * 47) % 360;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">` +
    `<rect width="96" height="96" rx="12" fill="hsl(${hue} 55% 45%)"/>` +
    `<text x="48" y="60" font-size="36" font-family="sans-serif" fill="white" text-anchor="middle">${initials}</text></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

// Opens (and on first run creates and seeds) the issuer database. Use ':memory:' in tests.
export function openIssuerDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  const count = db.prepare('SELECT COUNT(*) AS n FROM students').get() as { n: number };
  if (count.n === 0) {
    const insert = db.prepare(
      `INSERT INTO students (name, pnr, dob, address, class, section, branch, photo, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    FAKE_STUDENTS.forEach((s, i) => insert.run(...s, placeholderPhoto(s[0], i), new Date().toISOString()));
  }
  return db;
}
