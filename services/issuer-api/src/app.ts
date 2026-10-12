// Issuer API routes. The issuer database decides who may receive a credential.
// Every staff action needs a signed-in staff member with the right role; this is checked HERE on the
// server for each route, not only hidden in the user interface.
import { Hono, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import {
  ISSUER_ID, ISSUER_NAME, CREDENTIAL_TYPE, CREDENTIAL_TYPES, STATUS_LIST_URL, URLS, setBit, createFailureLimiter,
} from '@true/shared';
import {
  issueCredential, verifyHolderProof, randomClaimCode, randomToken, generateSigningKeyPair, sha256Hex, type Jwk,
} from '@true/credentials';
import type { Student, ClaimCode, IssuerKeyRow, StaffRow, StaffRole, CredentialRow, AuditRow } from './db.ts';
import { hashPin, pinMatches } from './pin.ts';

const CLAIM_CODE_MINUTES = 10;
const DEFAULT_VALID_DAYS = 365;
const SESSION_MINUTES = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// Reason CODES only: free text could leak personal details into logs.
const STUDENT_REVOKE_REASONS = ['left_institution', 'graduated', 'lost_device', 'issued_in_error', 'misconduct'] as const;
const CREDENTIAL_REVOKE_REASONS = ['lost', 'no_longer_valid', 'violation', 'duplicate', 'other'] as const;
const REINSTATE_REASONS = ['revoked_in_error', 're_enrolled', 'device_replaced', 'appeal_accepted'] as const;

// What each role may do. Every signed-in staff member may read. Admin may do everything.
export type Permission = 'issue' | 'revoke' | 'keys' | 'staff';
const PERMISSIONS: Record<StaffRole, Permission[]> = {
  admin: ['issue', 'revoke', 'keys', 'staff'],
  issuer: ['issue'],
  revoker: ['revoke'],
  auditor: [],
};
const ROLES = ['admin', 'issuer', 'revoker', 'auditor'] as const;

export type IssuerKeys = { publicJwk: Jwk; privateJwk: Jwk };

// The issuer's writes to the public registry on the chain. Optional so tests can run without a chain.
export type IssuerChain = {
  addIssuerKey: (keyId: string, publicJwk: Jwk) => Promise<unknown>;
  setIssuerKeyState: (keyId: string, state: 'Retired' | 'Compromised') => Promise<unknown>;
  anchorStatusList: (hashHex: string, version: number) => Promise<unknown>;
};

export type IssuerOptions = {
  // 'off' is for tests of other features only: every request is treated as an admin. Never used by server.ts.
  staffAuth?: 'off';
  // Staff created on a brand-new database (the demo's four fake staff; PINs come from .env).
  seedStaff?: { id: string; name: string; role: StaffRole; pin: string }[];
  now?: () => number; // clock in milliseconds; tests move it
};

type SignedInStaff = { id: string; name: string; role: StaffRole };

// Every refusal uses the same JSON shape: { error: { code, message } }.
const refuse = (code: string, message: string) => ({ error: { code, message } });

// True if the person is 18 or older today. The issuer computes this so no verifier needs the birth date.
function isOver18(dob: string): boolean {
  const birth = new Date(dob);
  const eighteenth = new Date(birth.getFullYear() + 18, birth.getMonth(), birth.getDate());
  return eighteenth <= new Date();
}

// The fingerprint that goes on the chain: SHA-256 of the list's hex text.
export const statusListHash = (bitsHex: string) => sha256Hex(bitsHex);

export function createIssuerApp(db: DatabaseSync, firstKey: IssuerKeys, chain?: IssuerChain, options: IssuerOptions = {}) {
  const app = new Hono<{ Variables: { staff: SignedInStaff } }>();
  app.use('*', cors());
  const now = options.now ?? Date.now;
  const isoNow = () => new Date(now()).toISOString();

  // ====================================================================================
  // Staff, sign-in and permissions
  // ====================================================================================

  if ((db.prepare('SELECT COUNT(*) AS n FROM staff').get() as { n: number }).n === 0) {
    for (const s of options.seedStaff ?? []) {
      db.prepare('INSERT INTO staff (id, name, role, pin_hash, active, created_at) VALUES (?, ?, ?, ?, 1, ?)').run(s.id, s.name, s.role, hashPin(s.pin), isoNow());
    }
  }

  // Signed-in sessions, kept in memory: token => who and until when. A restart signs everyone out.
  const sessions = new Map<string, { staffId: string; expiresAt: number }>();
  // Wrong PINs: 5 in a minute locks that staff id for a minute.
  const pinLimiter = createFailureLimiter({ max: 5, windowSeconds: 60, blockSeconds: 60, now });

  // Audit log: what, when, which staff id, and the id of the thing acted on. Never a name.
  function audit(type: string, staffId: string | null, subject: string) {
    db.prepare('INSERT INTO audit_events (ts, type, staff_id, subject) VALUES (?, ?, ?, ?)').run(isoNow(), type, staffId, subject);
  }

  // Route guard. Without an argument: any signed-in, active staff member. With one: that permission is required.
  const staff = (permission?: Permission): MiddlewareHandler<{ Variables: { staff: SignedInStaff } }> => async (c, next) => {
    if (options.staffAuth === 'off') {
      c.set('staff', { id: 'test-staff', name: 'Test', role: 'admin' });
      return next();
    }
    const token = (c.req.header('authorization') ?? '').replace(/^Bearer /, '');
    const session = sessions.get(token);
    if (!session || session.expiresAt < now()) return c.json(refuse('not_signed_in', 'Sign in with a staff PIN first'), 401);
    const row = db.prepare('SELECT * FROM staff WHERE id = ?').get(session.staffId) as StaffRow | undefined;
    // Checked on every request, so deactivating someone takes effect immediately.
    if (!row || !row.active) return c.json(refuse('staff_inactive', 'This staff account is not active'), 403);
    if (permission && !PERMISSIONS[row.role].includes(permission)) {
      return c.json(refuse('forbidden', `Your role (${row.role}) is not allowed to do this`), 403);
    }
    c.set('staff', { id: row.id, name: row.name, role: row.role });
    await next();
  };

  // Public: who can sign in (for the PIN screen). Names of staff, nothing about students.
  app.get('/v1/staff/directory', (c) => {
    const rows = db.prepare('SELECT id, name, role FROM staff WHERE active = 1 ORDER BY id').all();
    return c.json({ issuerName: ISSUER_NAME, staff: rows });
  });

  // PIN sign-in. Returns a short-lived session token.
  app.post('/v1/staff/login', async (c) => {
    const body = z.object({ staffId: z.string(), pin: z.string() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(refuse('bad_request', 'staffId and pin are required'), 400);
    const { staffId, pin } = body.data;

    const wait = pinLimiter.retryAfter(staffId);
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      return c.json(refuse('too_many_attempts', `Too many wrong PINs, try again in ${wait} seconds`), 429);
    }
    const row = db.prepare('SELECT * FROM staff WHERE id = ?').get(staffId) as StaffRow | undefined;
    if (row && !row.active) return c.json(refuse('staff_inactive', 'This staff account is not active'), 403);
    if (!row || !pinMatches(pin, row.pin_hash)) {
      pinLimiter.recordFailure(staffId);
      audit('staff.login_failed', null, staffId);
      return c.json(refuse('wrong_pin', 'Wrong staff id or PIN'), 401);
    }
    const token = randomToken() + randomToken();
    const expiresAt = now() + SESSION_MINUTES * 60_000;
    sessions.set(token, { staffId: row.id, expiresAt });
    audit('staff.login', row.id, row.id);
    return c.json({ token, expiresAt: new Date(expiresAt).toISOString(), staff: { id: row.id, name: row.name, role: row.role, permissions: PERMISSIONS[row.role] } });
  });

  app.post('/v1/staff/logout', staff(), (c) => {
    sessions.delete((c.req.header('authorization') ?? '').replace(/^Bearer /, ''));
    return c.json({ ok: true });
  });

  // Admin: staff management.
  app.get('/v1/staff', staff('staff'), (c) =>
    c.json({ staff: db.prepare('SELECT id, name, role, active, created_at FROM staff ORDER BY id').all() }),
  );

  app.post('/v1/staff', staff('staff'), async (c) => {
    const body = z.object({ name: z.string().min(2).max(60), role: z.enum(ROLES), pin: z.string().regex(/^\d{4,8}$/) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(refuse('bad_request', 'name, role and a PIN of 4 to 8 digits are required'), 400);
    const count = (db.prepare('SELECT COUNT(*) AS n FROM staff').get() as { n: number }).n;
    const id = `S-${String(count + 1).padStart(3, '0')}`;
    db.prepare('INSERT INTO staff (id, name, role, pin_hash, active, created_at) VALUES (?, ?, ?, ?, 1, ?)').run(id, body.data.name, body.data.role, hashPin(body.data.pin), isoNow());
    audit('staff.added', c.get('staff').id, id);
    return c.json({ id, name: body.data.name, role: body.data.role }, 201);
  });

  app.post('/v1/staff/:id/deactivate', staff('staff'), (c) => {
    const id = c.req.param('id');
    if (id === c.get('staff').id) return c.json(refuse('cannot_deactivate_self', 'You cannot deactivate your own account'), 409);
    const done = db.prepare('UPDATE staff SET active = 0 WHERE id = ? AND active = 1').run(id);
    if (done.changes !== 1) return c.json(refuse('unknown_staff', 'No such active staff member'), 404);
    audit('staff.deactivated', c.get('staff').id, id);
    return c.json({ ok: true });
  });

  // ====================================================================================
  // Signing keys
  // ====================================================================================

  // On a brand-new database, store the first key as "key-1".
  const keyCount = db.prepare('SELECT COUNT(*) AS n FROM issuer_keys').get() as { n: number };
  if (keyCount.n === 0) insertKey('key-1', firstKey);

  function insertKey(kid: string, keys: IssuerKeys) {
    db.prepare('INSERT INTO issuer_keys (kid, public_jwk, private_jwk, state, created_at) VALUES (?, ?, ?, ?, ?)').run(
      kid, JSON.stringify(keys.publicJwk), JSON.stringify(keys.privateJwk), 'Active', isoNow(),
    );
  }
  const allKeys = () => db.prepare('SELECT * FROM issuer_keys ORDER BY created_at, kid').all() as IssuerKeyRow[];
  const activeKey = () => db.prepare("SELECT * FROM issuer_keys WHERE state = 'Active'").get() as IssuerKeyRow;

  // Make a new Active key and publish its public half on the chain.
  async function createNewKey(): Promise<string> {
    const kid = `key-${allKeys().length + 1}`;
    const keys = await generateSigningKeyPair();
    insertKey(kid, keys);
    await chain?.addIssuerKey(kid, keys.publicJwk);
    return kid;
  }

  // The issuer's keys and their states (never the private halves).
  app.get('/v1/keys', staff(), (c) => c.json({ keys: allKeys().map((k) => ({ kid: k.kid, state: k.state, createdAt: k.created_at })) }));

  // Normal rotation. New key becomes Active; the old one is Retired, so credentials it signed stay valid.
  app.post('/v1/keys/rotate', staff('keys'), async (c) => {
    const old = activeKey();
    db.prepare("UPDATE issuer_keys SET state = 'Retired' WHERE kid = ?").run(old.kid);
    const kid = await createNewKey();
    await chain?.setIssuerKeyState(old.kid, 'Retired');
    audit('key.rotated', c.get('staff').id, kid);
    return c.json({ ok: true, activeKeyId: kid, retiredKeyId: old.kid });
  });

  // Emergency. The key leaked: verifiers must reject everything it signed. If it was the Active key, make a new one.
  app.post('/v1/keys/:kid/compromise', staff('keys'), async (c) => {
    const key = allKeys().find((k) => k.kid === c.req.param('kid'));
    if (!key) return c.json(refuse('unknown_key', 'No such key'), 404);
    if (key.state === 'Compromised') return c.json(refuse('already_compromised', 'This key is already marked compromised'), 409);
    db.prepare("UPDATE issuer_keys SET state = 'Compromised' WHERE kid = ?").run(key.kid);
    const activeKeyId = key.state === 'Active' ? await createNewKey() : activeKey().kid;
    await chain?.setIssuerKeyState(key.kid, 'Compromised');
    audit('key.compromised', c.get('staff').id, key.kid);
    return c.json({ ok: true, compromisedKeyId: key.kid, activeKeyId });
  });

  // ====================================================================================
  // Revocation list
  // ====================================================================================

  const statusList = () => db.prepare('SELECT bits_hex, version FROM status_list WHERE id = 1').get() as { bits_hex: string; version: number };

  // Flip the bits at these positions, bump the version, and publish the new fingerprint on the chain.
  // Returns true if the chain now holds the new fingerprint. Verifiers only accept a list that matches it.
  async function revokePositions(indexes: number[]): Promise<boolean> {
    if (indexes.length === 0) return false;
    const old = statusList();
    const bitsHex = indexes.reduce((bits, index) => setBit(bits, index), old.bits_hex);
    const version = old.version + 1;
    db.prepare('UPDATE status_list SET bits_hex = ?, version = ? WHERE id = 1').run(bitsHex, version);
    for (const index of indexes) db.prepare('INSERT OR IGNORE INTO retired_indexes (idx) VALUES (?)').run(index);
    try { await chain?.anchorStatusList(statusListHash(bitsHex), version); return Boolean(chain); } catch { return false; }
  }

  // Next free position: one past the highest ever used anywhere. A position is never handed out twice.
  function nextStatusIndex(): number {
    const max = db.prepare(`SELECT MAX(m) AS m FROM (
        SELECT MAX(status_list_index) AS m FROM students
        UNION ALL SELECT MAX(status_list_index) FROM credentials
        UNION ALL SELECT MAX(idx) FROM retired_indexes)`).get() as { m: number | null };
    return max.m === null ? 0 : max.m + 1;
  }

  // Public: the whole revocation list. The same file for everyone, so we cannot tell who is being checked.
  app.get('/v1/status-list', (c) => {
    const list = statusList();
    return c.json({ issuerId: ISSUER_ID, version: list.version, bitsHex: list.bits_hex });
  });

  // ====================================================================================
  // Public endpoints for wallets
  // ====================================================================================

  // Who this issuer is and which key it currently signs with.
  app.get('/v1/.well-known/issuer', (c) => {
    const key = activeKey();
    return c.json({ id: ISSUER_ID, name: ISSUER_NAME, keyId: key.kid, publicJwk: JSON.parse(key.public_jwk) });
  });

  // Looks up a claim code and says why it cannot be used, if it cannot.
  function checkClaimCode(code: string): { row: ClaimCode } | { code: string; message: string } {
    const row = db.prepare('SELECT * FROM claim_codes WHERE code = ?').get(code) as ClaimCode | undefined;
    if (!row) return { code: 'unknown_code', message: 'This claim code does not exist' };
    if (row.used_at) return { code: 'code_used', message: 'This claim code was already used' };
    if (new Date(row.expires_at).getTime() < now()) return { code: 'code_expired', message: 'This claim code has expired' };
    return { row };
  }
  const credentialForCode = (code: string) => db.prepare('SELECT * FROM credentials WHERE claim_code = ?').get(code) as CredentialRow | undefined;

  // Wallet: step 1 of claiming. Returns the nonce the wallet must sign to prove it owns its key.
  app.get('/v1/claim-codes/:code', (c) => {
    const checked = checkClaimCode(c.req.param('code').toUpperCase());
    if (!('row' in checked)) return c.json(refuse(checked.code, checked.message), 400);
    return c.json({
      issuerId: ISSUER_ID,
      issuerName: ISSUER_NAME,
      credentialType: credentialForCode(checked.row.code)?.type ?? CREDENTIAL_TYPE,
      nonce: checked.row.nonce,
      expiresAt: checked.row.expires_at,
    });
  });

  // Wallet: step 2 of claiming. Sends the code and a signed proof that contains the wallet's public key.
  app.post('/v1/credentials', async (c) => {
    const body = z.object({ code: z.string(), proof: z.string() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(refuse('bad_request', 'code and proof are required'), 400);

    const checked = checkClaimCode(body.data.code.toUpperCase());
    if (!('row' in checked)) return c.json(refuse(checked.code, checked.message), 400);
    const claimCode = checked.row;

    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(claimCode.student_id) as Student;
    if (student.status !== 'active') return c.json(refuse('student_not_active', 'This student is revoked'), 409);
    const record = credentialForCode(claimCode.code);
    if (!record || record.status !== 'pending') return c.json(refuse('offer_withdrawn', 'This offer is no longer open'), 409);

    // The proof must be signed over THIS code's nonce, by the key it carries.
    const holderPublicJwk = await verifyHolderProof(body.data.proof, { nonce: claimCode.nonce, audience: ISSUER_ID });
    if (!holderPublicJwk) return c.json(refuse('bad_holder_proof', 'Proof of key ownership failed'), 400);

    // Mark the code used FIRST, and only continue if this request was the one that marked it.
    // This stops two requests racing with the same code from both getting a credential.
    const marked = db.prepare('UPDATE claim_codes SET used_at = ? WHERE code = ? AND used_at IS NULL').run(isoNow(), claimCode.code);
    if (marked.changes !== 1) return c.json(refuse('code_used', 'This claim code was already used'), 400);

    // Every credential gets its own position in the revocation list.
    const statusIndex = nextStatusIndex();
    // An older credential of the same type for this student is now "replaced" (it stays valid until revoked).
    db.prepare("UPDATE credentials SET status = 'replaced' WHERE student_id = ? AND type = ? AND status = 'active'").run(student.id, record.type);
    db.prepare("UPDATE credentials SET status = 'active', claimed_at = ?, status_list_index = ? WHERE id = ?").run(isoNow(), statusIndex, record.id);
    if (record.type === CREDENTIAL_TYPE) db.prepare('UPDATE students SET status_list_index = ? WHERE id = ?').run(statusIndex, student.id);

    // What goes inside depends on the credential type. Each claim can later be shown or hidden separately.
    const claims: Record<string, unknown> = record.type === 'LibraryCard'
      ? { name: student.name, pnr: student.pnr, photo: student.photo, institution: ISSUER_NAME, library_member: true }
      : {
          // Raw claims, copied from the student row.
          name: student.name, pnr: student.pnr, dob: student.dob, address: student.address, class: student.class,
          section: student.section, branch: student.branch, photo: student.photo, institution: ISSUER_NAME,
          // Derived claims: separate yes/no facts, so these checks never need the raw date of birth.
          is_student: true,
          age_over_18: isOver18(student.dob),
        };

    const key = activeKey();
    const credential = await issueCredential({
      issuerId: ISSUER_ID,
      issuerPrivateJwk: JSON.parse(key.private_jwk),
      keyId: key.kid,
      holderPublicJwk,
      statusIndex,
      statusListUrl: STATUS_LIST_URL,
      type: record.type,
      expiresAt: Math.floor(new Date(record.valid_till).getTime() / 1000),
      claims,
    });
    audit('credential.claimed', null, record.id);
    return c.json({ credential, issuerId: ISSUER_ID, issuerName: ISSUER_NAME, credentialId: record.id }, 201);
  });

  // ====================================================================================
  // Students and issuing
  // ====================================================================================

  // Search students by name, PNR or id. Without q: everyone.
  app.get('/v1/students', staff(), (c) => {
    const q = (c.req.query('q') ?? '').trim();
    const students = q
      ? db.prepare('SELECT * FROM students WHERE name LIKE ? OR pnr LIKE ? OR CAST(id AS TEXT) = ? ORDER BY id').all(`%${q}%`, `%${q}%`, q)
      : db.prepare('SELECT * FROM students ORDER BY id').all();
    return c.json({ students });
  });

  // Counts by student, used by the old issuer console. "Issued" = students who have collected a Student ID.
  app.get('/v1/stats', staff(), (c) => {
    const row = db.prepare(`SELECT
        COUNT(status_list_index) AS issued,
        SUM(CASE WHEN status_list_index IS NOT NULL AND status = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status = 'revoked' THEN 1 ELSE 0 END) AS revoked
      FROM students`).get() as { issued: number; active: number | null; revoked: number | null };
    return c.json({ issued: row.issued, active: row.active ?? 0, revoked: row.revoked ?? 0 });
  });

  // Creates the registry entry and its one-time claim code. Returns a refusal object if the student may not be issued to.
  function createOffer(input: { studentId: number; type: string; validFrom: string; validTill: string; staffId: string }) {
    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(input.studentId) as Student | undefined;
    if (!student) return { refusal: refuse('unknown_student', 'No such student in the issuer database'), status: 404 as const };
    if (student.status !== 'active') return { refusal: refuse('student_not_active', 'This student is revoked'), status: 409 as const };

    const code = randomClaimCode();
    const expiresAt = new Date(now() + CLAIM_CODE_MINUTES * 60_000).toISOString();
    db.prepare('INSERT INTO claim_codes (code, student_id, nonce, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(code, student.id, randomToken(), isoNow(), expiresAt);
    const count = (db.prepare('SELECT COUNT(*) AS n FROM credentials').get() as { n: number }).n;
    const id = `TR-${input.type === 'LibraryCard' ? 'LIB' : 'SID'}-${String(count + 1).padStart(4, '0')}`;
    db.prepare(`INSERT INTO credentials (id, student_id, type, status, claim_code, valid_from, valid_till, issued_by, created_at)
                VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`).run(id, student.id, input.type, code, input.validFrom, input.validTill, input.staffId, isoNow());
    audit('credential.offered', input.staffId, id);
    return {
      offer: {
        credentialId: id, code, expiresAt,
        offerUrl: `${URLS.wallet}/#/claim?code=${code}`, // opens the original wallet
        appOfferUrl: `${URLS.app}/#/claim?code=${code}`, // opens the new app
      },
    };
  }
  const defaultValidity = () => ({ validFrom: isoNow(), validTill: new Date(now() + DEFAULT_VALID_DAYS * DAY_MS).toISOString() });

  // "Issue credential" in the old console: a Student ID with the default one-year validity.
  app.post('/v1/claim-codes', staff('issue'), async (c) => {
    const body = z.object({ studentId: z.number().int() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(refuse('bad_request', 'studentId (number) is required'), 400);
    const result = createOffer({ studentId: body.data.studentId, type: CREDENTIAL_TYPE, ...defaultValidity(), staffId: c.get('staff').id });
    if ('refusal' in result) return c.json(result.refusal, result.status);
    return c.json(result.offer, 201);
  });

  // "Issue New Credential" in the new app: choose the type and the validity dates.
  app.post('/v1/issue', staff('issue'), async (c) => {
    const body = z.object({
      studentId: z.number().int(),
      type: z.enum(Object.keys(CREDENTIAL_TYPES) as [string, ...string[]]),
      validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      validTill: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(refuse('bad_request', 'studentId, type, validFrom and validTill (YYYY-MM-DD) are required'), 400);
    const validFrom = new Date(body.data.validFrom + 'T00:00:00').toISOString();
    const validTill = new Date(body.data.validTill + 'T23:59:59').toISOString();
    if (new Date(validTill).getTime() <= now() || validTill <= validFrom) return c.json(refuse('bad_validity', '"Valid till" must be in the future and after "Valid from"'), 400);
    const result = createOffer({ studentId: body.data.studentId, type: body.data.type, validFrom, validTill, staffId: c.get('staff').id });
    if ('refusal' in result) return c.json(result.refusal, result.status);
    return c.json(result.offer, 201);
  });

  // ====================================================================================
  // Registry, dashboard, activity, reports (read-only: any signed-in staff)
  // ====================================================================================

  // A registry row as the issuer console shows it. The student's name is joined in here, for the issuer's own screen.
  const REGISTRY_SQL = `SELECT c.*, s.name AS student_name, s.pnr AS student_pnr, s.branch AS student_branch, s.status AS student_status,
      k.expires_at AS code_expires_at
    FROM credentials c JOIN students s ON s.id = c.student_id JOIN claim_codes k ON k.code = c.claim_code`;
  type RegistryRow = CredentialRow & { student_name: string; student_pnr: string; student_branch: string; student_status: string; code_expires_at: string };
  // A pending offer whose claim code has run out is shown as "expired": it can no longer be collected.
  const withDisplayStatus = (row: RegistryRow) => ({
    ...row,
    display_status: row.status === 'pending' && new Date(row.code_expires_at).getTime() < now() ? 'expired' : row.status,
  });

  app.get('/v1/registry', staff(), (c) => {
    const rows = (db.prepare(`${REGISTRY_SQL} ORDER BY c.created_at DESC`).all() as RegistryRow[]).map(withDisplayStatus);
    const status = c.req.query('status');
    return c.json({ credentials: status ? rows.filter((row) => row.display_status === status) : rows });
  });

  app.get('/v1/registry/:id', staff(), (c) => {
    const row = db.prepare(`${REGISTRY_SQL} WHERE c.id = ?`).get(c.req.param('id')) as RegistryRow | undefined;
    if (!row) return c.json(refuse('unknown_credential', 'No such credential'), 404);
    return c.json({ credential: withDisplayStatus(row) });
  });

  // Dashboard numbers, straight from the registry.
  function counts() {
    const rows = (db.prepare(`${REGISTRY_SQL}`).all() as RegistryRow[]).map(withDisplayStatus);
    return {
      issued: rows.filter((r) => r.claimed_at !== null).length, // collected by a holder at some point
      active: rows.filter((r) => r.display_status === 'active').length,
      pending: rows.filter((r) => r.display_status === 'pending').length, // offered, not collected, code still valid
      revoked: rows.filter((r) => r.display_status === 'revoked').length,
    };
  }

  app.get('/v1/dashboard', staff(), (c) =>
    c.json({
      issuer: { id: ISSUER_ID, name: ISSUER_NAME },
      counts: counts(),
      recent: db.prepare("SELECT * FROM audit_events WHERE type NOT LIKE 'staff.login%' ORDER BY id DESC LIMIT 6").all(),
    }),
  );

  // Audit events, newest first. kind = issue | revoke | other. Identifiers only; the console joins names itself.
  app.get('/v1/audit', staff(), (c) => {
    const kinds: Record<string, string> = {
      issue: "type IN ('credential.offered', 'credential.claimed', 'request.approved')",
      revoke: "type IN ('credential.revoked', 'student.revoked', 'student.reinstated')",
    };
    const where = kinds[c.req.query('kind') ?? ''] ?? '1 = 1';
    return c.json({ events: db.prepare(`SELECT * FROM audit_events WHERE ${where} ORDER BY id DESC LIMIT 200`).all() as AuditRow[] });
  });

  // Last-30-days report, computed from the registry on every call.
  app.get('/v1/reports', staff(), (c) => {
    const since = new Date(now() - 30 * DAY_MS).toISOString();
    const rows = db.prepare('SELECT * FROM credentials').all() as CredentialRow[];
    const claimed = rows.filter((r) => r.claimed_at !== null && r.claimed_at >= since);
    // One point per day, oldest first: how many credentials were collected that day.
    const trend = Array.from({ length: 30 }, (_, i) => {
      const day = new Date(now() - (29 - i) * DAY_MS).toISOString().slice(0, 10);
      return { day, issued: claimed.filter((r) => r.claimed_at!.slice(0, 10) === day).length };
    });
    const byType = Object.keys(CREDENTIAL_TYPES).map((type) => ({ type, count: claimed.filter((r) => r.type === type).length }));
    return c.json({
      since,
      counts: {
        issued: claimed.length,
        offered: rows.filter((r) => r.created_at >= since).length,
        revoked: rows.filter((r) => r.revoked_at !== null && r.revoked_at >= since).length,
        active: counts().active,
        pending: counts().pending,
      },
      trend,
      byType,
    });
  });

  // ====================================================================================
  // Revoking and giving back
  // ====================================================================================

  // Mark these registry rows revoked and flip their bits.
  async function revokeCredentials(rows: CredentialRow[], reason: string, staffId: string, extraIndexes: number[] = []): Promise<boolean> {
    for (const row of rows) {
      db.prepare("UPDATE credentials SET status = 'revoked', revoked_reason = ?, revoked_at = ?, revoked_by = ? WHERE id = ?").run(reason, isoNow(), staffId, row.id);
      audit('credential.revoked', staffId, row.id);
    }
    const indexes = [...rows.map((r) => r.status_list_index), ...extraIndexes].filter((i): i is number => i !== null);
    return revokePositions([...new Set(indexes)]);
  }

  // New app: revoke ONE credential (and any older copies of it that it replaced). The student stays eligible.
  app.post('/v1/registry/:id/revoke', staff('revoke'), async (c) => {
    const body = z.object({ reason: z.enum(CREDENTIAL_REVOKE_REASONS) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(refuse('bad_request', `reason must be one of: ${CREDENTIAL_REVOKE_REASONS.join(', ')}`), 400);
    const row = db.prepare('SELECT * FROM credentials WHERE id = ?').get(c.req.param('id')) as CredentialRow | undefined;
    if (!row) return c.json(refuse('unknown_credential', 'No such credential'), 404);
    if (row.status === 'revoked') return c.json(refuse('already_revoked', 'This credential is already revoked'), 409);

    const olderCopies = db.prepare("SELECT * FROM credentials WHERE student_id = ? AND type = ? AND status = 'replaced'").all(row.student_id, row.type) as CredentialRow[];
    const anchored = await revokeCredentials([row, ...olderCopies], body.data.reason, c.get('staff').id);
    if (row.type === CREDENTIAL_TYPE) db.prepare('UPDATE students SET status_list_index = NULL WHERE id = ?').run(row.student_id);
    return c.json({ ok: true, credentialId: row.id, statusIndex: row.status_list_index, anchored });
  });

  // Old console: revoke a STUDENT. Every credential they hold is revoked and they cannot be issued to until given back.
  app.post('/v1/students/:id/revoke', staff('revoke'), async (c) => {
    const body = z.object({ reason: z.enum(STUDENT_REVOKE_REASONS) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(refuse('bad_request', `reason must be one of: ${STUDENT_REVOKE_REASONS.join(', ')}`), 400);
    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(Number(c.req.param('id'))) as Student | undefined;
    if (!student) return c.json(refuse('unknown_student', 'No such student in the issuer database'), 404);
    if (student.status === 'revoked') return c.json(refuse('already_revoked', 'This student is already revoked'), 409);

    db.prepare("UPDATE students SET status = 'revoked', revoked_reason = ? WHERE id = ?").run(body.data.reason, student.id);
    audit('student.revoked', c.get('staff').id, `student:${student.id}`);
    const rows = db.prepare("SELECT * FROM credentials WHERE student_id = ? AND status != 'revoked'").all(student.id) as CredentialRow[];
    const anchored = await revokeCredentials(rows, body.data.reason, c.get('staff').id, student.status_list_index === null ? [] : [student.status_list_index]);
    return c.json({ ok: true, statusIndex: student.status_list_index, anchored });
  });

  // Old console: give a revoked student their eligibility back. A reason code must be filled in.
  // The OLD credentials stay revoked for ever (bits are never cleared). The student becomes active again
  // and must collect a NEW credential, which gets a new position in the list.
  app.post('/v1/students/:id/reinstate', staff('revoke'), async (c) => {
    const body = z.object({ reason: z.enum(REINSTATE_REASONS) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(refuse('bad_request', `reason must be one of: ${REINSTATE_REASONS.join(', ')}`), 400);
    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(Number(c.req.param('id'))) as Student | undefined;
    if (!student) return c.json(refuse('unknown_student', 'No such student in the issuer database'), 404);
    if (student.status !== 'revoked') return c.json(refuse('not_revoked', 'Only a revoked student can be reinstated'), 409);

    if (student.status_list_index !== null) db.prepare('INSERT OR IGNORE INTO retired_indexes (idx) VALUES (?)').run(student.status_list_index);
    db.prepare("UPDATE students SET status = 'active', revoked_reason = NULL, status_list_index = NULL WHERE id = ?").run(student.id);
    audit('student.reinstated', c.get('staff').id, `student:${student.id}`);
    return c.json({ ok: true, reason: body.data.reason, retiredStatusIndex: student.status_list_index });
  });

  return app;
}
