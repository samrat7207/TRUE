// Issuer API routes. The issuer database decides who may receive a credential.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { ISSUER_ID, ISSUER_NAME, CREDENTIAL_TYPE, STATUS_LIST_URL, URLS, setBit } from '@true/shared';
import {
  issueCredential, verifyHolderProof, randomClaimCode, randomToken, generateSigningKeyPair, sha256Hex, type Jwk,
} from '@true/credentials';
import type { Student, ClaimCode, IssuerKeyRow } from './db.ts';

const CLAIM_CODE_MINUTES = 10;
const CREDENTIAL_VALID_DAYS = 365;

// Reason CODES only: free text could leak personal details into logs.
const REVOKE_REASONS = ['left_institution', 'graduated', 'lost_device', 'issued_in_error', 'misconduct'] as const;
const REINSTATE_REASONS = ['revoked_in_error', 're_enrolled', 'device_replaced', 'appeal_accepted'] as const;

export type IssuerKeys = { publicJwk: Jwk; privateJwk: Jwk };

// The issuer's writes to the public registry on the chain. Optional so tests can run without a chain.
export type IssuerChain = {
  addIssuerKey: (keyId: string, publicJwk: Jwk) => Promise<unknown>;
  setIssuerKeyState: (keyId: string, state: 'Retired' | 'Compromised') => Promise<unknown>;
  anchorStatusList: (hashHex: string, version: number) => Promise<unknown>;
};

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

export function createIssuerApp(db: DatabaseSync, firstKey: IssuerKeys, chain?: IssuerChain) {
  const app = new Hono();
  app.use('*', cors());

  // ---------- signing keys ----------

  // On a brand-new database, store the first key as "key-1".
  const keyCount = db.prepare('SELECT COUNT(*) AS n FROM issuer_keys').get() as { n: number };
  if (keyCount.n === 0) insertKey('key-1', firstKey);

  function insertKey(kid: string, keys: IssuerKeys) {
    db.prepare('INSERT INTO issuer_keys (kid, public_jwk, private_jwk, state, created_at) VALUES (?, ?, ?, ?, ?)').run(
      kid, JSON.stringify(keys.publicJwk), JSON.stringify(keys.privateJwk), 'Active', new Date().toISOString(),
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

  // ---------- revocation list ----------

  const statusList = () => db.prepare('SELECT bits_hex, version FROM status_list WHERE id = 1').get() as { bits_hex: string; version: number };

  // ---------- routes ----------

  // Public: who this issuer is and which key it currently signs with.
  app.get('/v1/.well-known/issuer', (c) => {
    const key = activeKey();
    return c.json({ id: ISSUER_ID, name: ISSUER_NAME, keyId: key.kid, publicJwk: JSON.parse(key.public_jwk) });
  });

  // Admin: list students for the issuer screen.
  app.get('/v1/students', (c) => {
    const students = db.prepare('SELECT * FROM students ORDER BY id').all() as Student[];
    return c.json({ students });
  });

  // Admin: counts for the issuer screen. "Issued" = students who have collected a credential.
  app.get('/v1/stats', (c) => {
    const row = db.prepare(`SELECT
        COUNT(status_list_index) AS issued,
        SUM(CASE WHEN status_list_index IS NOT NULL AND status = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status = 'revoked' THEN 1 ELSE 0 END) AS revoked
      FROM students`).get() as { issued: number; active: number | null; revoked: number | null };
    return c.json({ issued: row.issued, active: row.active ?? 0, revoked: row.revoked ?? 0 });
  });

  // Admin: "Issue credential" button. Creates a one-time, short-lived claim code for one student.
  app.post('/v1/claim-codes', async (c) => {
    const body = z.object({ studentId: z.number().int() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(refuse('bad_request', 'studentId (number) is required'), 400);

    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(body.data.studentId) as Student | undefined;
    if (!student) return c.json(refuse('unknown_student', 'No such student in the issuer database'), 404);
    if (student.status !== 'active') return c.json(refuse('student_not_active', 'This student is revoked'), 409);

    const code = randomClaimCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CLAIM_CODE_MINUTES * 60_000).toISOString();
    db.prepare('INSERT INTO claim_codes (code, student_id, nonce, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
      code, student.id, randomToken(), now.toISOString(), expiresAt,
    );
    // The QR offer is just a link that opens the wallet with the code filled in.
    return c.json({ code, expiresAt, offerUrl: `${URLS.wallet}/#/claim?code=${code}` }, 201);
  });

  // Looks up a claim code and says why it cannot be used, if it cannot.
  function checkClaimCode(code: string): { row: ClaimCode } | { code: string; message: string } {
    const row = db.prepare('SELECT * FROM claim_codes WHERE code = ?').get(code) as ClaimCode | undefined;
    if (!row) return { code: 'unknown_code', message: 'This claim code does not exist' };
    if (row.used_at) return { code: 'code_used', message: 'This claim code was already used' };
    if (new Date(row.expires_at) < new Date()) return { code: 'code_expired', message: 'This claim code has expired' };
    return { row };
  }

  // Wallet: step 1 of claiming. Returns the nonce the wallet must sign to prove it owns its key.
  app.get('/v1/claim-codes/:code', (c) => {
    const checked = checkClaimCode(c.req.param('code').toUpperCase());
    if (!('row' in checked)) return c.json(refuse(checked.code, checked.message), 400);
    return c.json({
      issuerId: ISSUER_ID,
      issuerName: ISSUER_NAME,
      credentialType: CREDENTIAL_TYPE,
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

    // The proof must be signed over THIS code's nonce, by the key it carries.
    const holderPublicJwk = await verifyHolderProof(body.data.proof, { nonce: claimCode.nonce, audience: ISSUER_ID });
    if (!holderPublicJwk) return c.json(refuse('bad_holder_proof', 'Proof of key ownership failed'), 400);

    // Mark the code used FIRST, and only continue if this request was the one that marked it.
    // This stops two requests racing with the same code from both getting a credential.
    const marked = db.prepare('UPDATE claim_codes SET used_at = ? WHERE code = ? AND used_at IS NULL').run(
      new Date().toISOString(), claimCode.code,
    );
    if (marked.changes !== 1) return c.json(refuse('code_used', 'This claim code was already used'), 400);

    // Give the student a position in the revocation status list (kept if they already have one).
    let statusIndex = student.status_list_index;
    if (statusIndex === null) {
      // Next free position: one past the highest ever used, including positions retired by a revocation.
      const max = db.prepare(
        'SELECT MAX(m) AS m FROM (SELECT MAX(status_list_index) AS m FROM students UNION ALL SELECT MAX(idx) FROM retired_indexes)',
      ).get() as { m: number | null };
      statusIndex = max.m === null ? 0 : max.m + 1;
      db.prepare('UPDATE students SET status_list_index = ? WHERE id = ?').run(statusIndex, student.id);
    }

    const key = activeKey();
    const credential = await issueCredential({
      issuerId: ISSUER_ID,
      issuerPrivateJwk: JSON.parse(key.private_jwk),
      keyId: key.kid,
      holderPublicJwk,
      statusIndex,
      statusListUrl: STATUS_LIST_URL,
      type: CREDENTIAL_TYPE,
      validDays: CREDENTIAL_VALID_DAYS,
      claims: {
        // Raw claims, copied from the student row.
        name: student.name,
        pnr: student.pnr,
        dob: student.dob,
        address: student.address,
        class: student.class,
        section: student.section,
        branch: student.branch,
        photo: student.photo,
        institution: ISSUER_NAME,
        // Derived claims: separate yes/no facts, so these checks never need the raw date of birth.
        is_student: true,
        age_over_18: isOver18(student.dob),
      },
    });
    return c.json({ credential, issuerId: ISSUER_ID, issuerName: ISSUER_NAME }, 201);
  });

  // Public: the whole revocation list. The same file for everyone, so we cannot tell who is being checked.
  app.get('/v1/status-list', (c) => {
    const list = statusList();
    return c.json({ issuerId: ISSUER_ID, version: list.version, bitsHex: list.bits_hex });
  });

  // Admin: revoke a student's credential. Flips their bit, then publishes the list's new fingerprint on the chain.
  app.post('/v1/students/:id/revoke', async (c) => {
    const body = z.object({ reason: z.enum(REVOKE_REASONS) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(refuse('bad_request', `reason must be one of: ${REVOKE_REASONS.join(', ')}`), 400);
    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(Number(c.req.param('id'))) as Student | undefined;
    if (!student) return c.json(refuse('unknown_student', 'No such student in the issuer database'), 404);
    if (student.status === 'revoked') return c.json(refuse('already_revoked', 'This student is already revoked'), 409);

    db.prepare("UPDATE students SET status = 'revoked', revoked_reason = ? WHERE id = ?").run(body.data.reason, student.id);
    let anchored = false;
    if (student.status_list_index !== null) {
      const old = statusList();
      const bitsHex = setBit(old.bits_hex, student.status_list_index);
      const version = old.version + 1;
      db.prepare('UPDATE status_list SET bits_hex = ?, version = ? WHERE id = 1').run(bitsHex, version);
      // Verifiers only accept a list whose fingerprint matches the chain.
      try { await chain?.anchorStatusList(statusListHash(bitsHex), version); anchored = Boolean(chain); } catch { anchored = false; }
    }
    return c.json({ ok: true, statusIndex: student.status_list_index, anchored });
  });

  // Admin: give a revoked student their eligibility back. A reason code must be filled in.
  // The OLD credential stays revoked for ever (its bit is never cleared). The student becomes active again
  // and must collect a NEW credential with a new claim code, which gets a new position in the list.
  app.post('/v1/students/:id/reinstate', async (c) => {
    const body = z.object({ reason: z.enum(REINSTATE_REASONS) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(refuse('bad_request', `reason must be one of: ${REINSTATE_REASONS.join(', ')}`), 400);
    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(Number(c.req.param('id'))) as Student | undefined;
    if (!student) return c.json(refuse('unknown_student', 'No such student in the issuer database'), 404);
    if (student.status !== 'revoked') return c.json(refuse('not_revoked', 'Only a revoked student can be reinstated'), 409);

    if (student.status_list_index !== null) db.prepare('INSERT OR IGNORE INTO retired_indexes (idx) VALUES (?)').run(student.status_list_index);
    db.prepare("UPDATE students SET status = 'active', revoked_reason = NULL, status_list_index = NULL WHERE id = ?").run(student.id);
    return c.json({ ok: true, reason: body.data.reason, retiredStatusIndex: student.status_list_index });
  });

  // Admin: the issuer's keys and their states (never the private halves).
  app.get('/v1/keys', (c) => c.json({ keys: allKeys().map((k) => ({ kid: k.kid, state: k.state, createdAt: k.created_at })) }));

  // Admin: normal rotation. New key becomes Active; the old one is Retired, so credentials it signed stay valid.
  app.post('/v1/keys/rotate', async (c) => {
    const old = activeKey();
    db.prepare("UPDATE issuer_keys SET state = 'Retired' WHERE kid = ?").run(old.kid);
    const kid = await createNewKey();
    await chain?.setIssuerKeyState(old.kid, 'Retired');
    return c.json({ ok: true, activeKeyId: kid, retiredKeyId: old.kid });
  });

  // Admin: emergency. The key leaked: verifiers must reject everything it signed. If it was the Active key, make a new one.
  app.post('/v1/keys/:kid/compromise', async (c) => {
    const key = allKeys().find((k) => k.kid === c.req.param('kid'));
    if (!key) return c.json(refuse('unknown_key', 'No such key'), 404);
    if (key.state === 'Compromised') return c.json(refuse('already_compromised', 'This key is already marked compromised'), 409);
    db.prepare("UPDATE issuer_keys SET state = 'Compromised' WHERE kid = ?").run(key.kid);
    const activeKeyId = key.state === 'Active' ? await createNewKey() : activeKey().kid;
    await chain?.setIssuerKeyState(key.kid, 'Compromised');
    return c.json({ ok: true, compromisedKeyId: key.kid, activeKeyId });
  });

  return app;
}
