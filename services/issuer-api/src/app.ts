// Core API: accounts (people and institutions), institutions issuing credentials, people accepting offers.
// Rules enforced here on the server:
//   - an institution only ever sees ITS OWN credentials, and can never list, browse or search people;
//   - a person only ever sees offers made to THEM;
//   - nothing in this file is called by the verifier, and nothing here calls the verifier.
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import {
  STATUS_LIST_ID, STATUS_LIST_URL, TEMPLATES, INSTITUTION_CATEGORIES, setBit, createFailureLimiter, createRateCounter, isAllowedOrigin,
  createEventLog, eventQuery, opsRefusal, OPS_ORIGINS, templateLabel,
} from '@true/shared';
import {
  issueCredential, verifyHolderProof, randomToken, generateSigningKeyPair, sha256Hex, signSession, verifySession, type Jwk,
} from '@true/credentials';
import type { Account, AuditEvent, Credential, InstitutionKey } from './db.ts';
import { hashPassword, passwordMatches } from './password.ts';

const SESSION_DAYS = 30;
const CREDENTIAL_VALID_DAYS = 365;
// Reason CODES only: free text could leak personal details into logs.
const REVOKE_REASONS = ['lost', 'no_longer_valid', 'violation', 'duplicate', 'other'] as const;

// This service's writes to the public registry on the chain. Optional so tests can run without a chain.
export type CoreChain = {
  registerInstitution: (institutionId: string, name: string) => Promise<unknown>;
  setVerified: (institutionId: string, verified: boolean) => Promise<unknown>;
  addIssuerKey: (institutionId: string, keyId: string, publicJwk: Jwk) => Promise<unknown>;
  setIssuerKeyState: (institutionId: string, keyId: string, state: 'Retired' | 'Compromised') => Promise<unknown>;
  anchorStatusList: (hashHex: string, version: number) => Promise<unknown>;
};

export type SeedAccount = { kind: 'person' | 'institution'; name: string; email: string; password: string; category?: string; verified?: boolean };

export type CoreOptions = {
  seedAccounts?: SeedAccount[]; // demo accounts created on a brand-new database
  now?: () => number; // clock in milliseconds; tests move it
  getSource?: (c: Context) => string; // caller's IP address, for the login rate limit
  getDevice?: (c: Context) => string | null; // short hashed label of the calling device, for the live event feed
};

type Vars = { Variables: { account: Account } };

// Every refusal uses the same JSON shape: { error: { code, message } }.
const refuse = (code: string, message: string) => ({ error: { code, message } });

// The fingerprint that goes on the chain: SHA-256 of the list's hex text.
export const statusListHash = (bitsHex: string) => sha256Hex(bitsHex);

export async function createCoreApp(db: DatabaseSync, chain?: CoreChain, options: CoreOptions = {}) {
  const app = new Hono<Vars>();
  // Browsers and the Android app may call us from this machine or from the local network only.
  // The operations routes (/ops/*) are stricter: only the app opened on the laptop itself.
  app.use('*', cors({ origin: (origin, c) => ((c.req.path.startsWith('/ops/') ? OPS_ORIGINS.includes(origin) : isAllowedOrigin(origin)) ? origin : null) }));
  const now = options.now ?? Date.now;
  const isoNow = () => new Date(now()).toISOString();
  const sourceOf = (c: Context) => options.getSource?.(c) ?? 'unknown';

  // ---------- live event feed for the Control Room (in memory, no personal data: see packages/shared/src/events.ts) ----------
  const events = createEventLog('issuer');
  const deviceOf = (c: Context) => options.getDevice?.(c) ?? null;

  // Operations routes answer ONLY to the server machine itself: a phone on the Wi-Fi gets 403.
  app.use('/ops/*', async (c, next) => {
    const refusal = opsRefusal({ address: sourceOf(c), forwardedFor: c.req.header('x-forwarded-for'), origin: c.req.header('origin') });
    if (refusal) return c.json(refuse('forbidden', `Operations routes are only for the server machine itself (${refusal})`), 403);
    await next();
  });
  app.get('/ops/events', (c) => {
    const { after, limit } = eventQuery((name) => c.req.query(name));
    return c.json(events.page(after, limit));
  });
  // "npm run verify-institution" runs in its own process and tells the running server here, so the feed can show it.
  // The line is written only if the database really says the institution is verified.
  app.post('/ops/notify/institution-verified', async (c) => {
    const body = z.object({ institutionId: z.string() }).safeParse(await c.req.json().catch(() => null));
    const account = body.success ? (db.prepare("SELECT * FROM accounts WHERE id = ? AND kind = 'institution' AND verified = 1").get(body.data.institutionId) as Account | undefined) : undefined;
    if (!account) return c.json(refuse('unknown_institution', 'No verified institution with that id'), 404);
    events.emit('success', 'institution_verified', `Institution verified: ${account.name}`);
    return c.json({ ok: true });
  });

  // Audit log: what, when, which account id, and the id of the thing acted on. Never a name or an email.
  function audit(type: string, actor: string | null, institutionId: string | null, subject: string) {
    db.prepare('INSERT INTO audit_events (ts, type, actor, institution_id, subject) VALUES (?, ?, ?, ?, ?)').run(isoNow(), type, actor, institutionId, subject);
  }

  // ====================================================================================
  // Session tokens
  // ====================================================================================

  // The key that signs session tokens is made once and kept in the database.
  let sessionKey = db.prepare('SELECT * FROM session_key WHERE id = 1').get() as { public_jwk: string; private_jwk: string } | undefined;
  if (!sessionKey) {
    const pair = await generateSigningKeyPair();
    sessionKey = { public_jwk: JSON.stringify(pair.publicJwk), private_jwk: JSON.stringify(pair.privateJwk) };
    db.prepare('INSERT INTO session_key (id, public_jwk, private_jwk) VALUES (1, ?, ?)').run(sessionKey.public_jwk, sessionKey.private_jwk);
  }
  const sessionPublicJwk: Jwk = JSON.parse(sessionKey.public_jwk);
  const sessionPrivateJwk: Jwk = JSON.parse(sessionKey.private_jwk);

  const tokenFor = (account: Account) => signSession({ sub: account.id, kind: account.kind, name: account.name }, sessionPrivateJwk, SESSION_DAYS);
  // What the app is told about an account. Never the password hash.
  const publicAccount = (a: Account) => ({ id: a.id, kind: a.kind, name: a.name, email: a.email, category: a.category, verified: a.verified === 1 });

  // Route guard: a valid session token for an account of this kind that still exists.
  const signedIn = (kind?: 'person' | 'institution'): MiddlewareHandler<Vars> => async (c, next) => {
    const session = await verifySession((c.req.header('authorization') ?? '').replace(/^Bearer /, ''), sessionPublicJwk);
    const account = session ? (db.prepare('SELECT * FROM accounts WHERE id = ?').get(session.sub) as Account | undefined) : undefined;
    // A deleted account's token stops working here at once, even though it has not expired.
    if (!account) return c.json(refuse('not_signed_in', 'Log in first'), 401);
    if (kind && account.kind !== kind) return c.json(refuse('forbidden', `Only ${kind} accounts can do this`), 403);
    c.set('account', account);
    await next();
  };

  // ====================================================================================
  // Accounts: sign up, log in, delete
  // ====================================================================================

  // Creates the account. An institution also gets its own signing key, published on the chain.
  async function createAccount(input: SeedAccount): Promise<Account> {
    const id = `${input.kind === 'person' ? 'person' : 'inst'}:${randomToken().slice(0, 12)}`;
    const institution = input.kind === 'institution';
    db.prepare('INSERT INTO accounts (id, kind, name, email, password_hash, category, verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, input.kind, input.name.trim(), input.email.trim().toLowerCase(), hashPassword(input.password),
      institution ? input.category ?? 'other' : null, institution && input.verified ? 1 : 0, isoNow(),
    );
    if (institution) {
      const keys = await generateSigningKeyPair();
      db.prepare("INSERT INTO institution_keys (institution_id, kid, public_jwk, private_jwk, state, created_at) VALUES (?, 'key-1', ?, ?, 'Active', ?)").run(
        id, JSON.stringify(keys.publicJwk), JSON.stringify(keys.privateJwk), isoNow(),
      );
      await chain?.registerInstitution(id, input.name.trim());
      await chain?.addIssuerKey(id, 'key-1', keys.publicJwk);
      if (input.verified) await chain?.setVerified(id, true);
    }
    audit('account.created', id, institution ? id : null, id);
    return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Account;
  }

  // Demo accounts, on a brand-new database only.
  if ((db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n === 0) {
    for (const seed of options.seedAccounts ?? []) await createAccount(seed);
  }

  const signupSchema = z.object({
    kind: z.enum(['person', 'institution']),
    name: z.string().trim().min(2).max(80),
    email: z.string().trim().toLowerCase().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
    password: z.string().min(8).max(200),
    category: z.enum(Object.keys(INSTITUTION_CATEGORIES) as [string, ...string[]]).optional(),
  });

  // Sign up. Emails are NOT verified in this demo. A new institution starts Unverified.
  app.post('/v1/auth/signup', async (c) => {
    const body = signupSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(refuse('bad_request', 'Need a name, a valid email and a password of at least 8 characters'), 400);
    if (db.prepare('SELECT 1 FROM accounts WHERE email = ?').get(body.data.email)) return c.json(refuse('email_taken', 'An account with this email already exists'), 409);
    const account = await createAccount({ ...body.data, verified: false });
    if (account.kind === 'institution') events.emit('warn', 'institution_unverified', `Institution signed up, not verified yet: ${account.name}`, deviceOf(c));
    else events.emit('info', 'signup', 'New person account created', deviceOf(c));
    return c.json({ token: await tokenFor(account), account: publicAccount(account) }, 201);
  });

  // Wrong passwords: 5 in a minute for one email locks that email for a minute.
  const loginLimiter = createFailureLimiter({ max: 5, windowSeconds: 60, blockSeconds: 60, now });

  app.post('/v1/auth/login', async (c) => {
    const body = z.object({ email: z.string().trim().toLowerCase(), password: z.string() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(refuse('bad_request', 'email and password are required'), 400);
    const key = `${body.data.email}|${sourceOf(c)}`;
    const wait = loginLimiter.retryAfter(key);
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      return c.json(refuse('too_many_attempts', `Too many attempts, try again in ${wait} seconds`), 429);
    }
    const account = db.prepare('SELECT * FROM accounts WHERE email = ?').get(body.data.email) as Account | undefined;
    if (!account || !passwordMatches(body.data.password, account.password_hash)) {
      const locked = loginLimiter.recordFailure(key);
      events.emit('warn', 'login_failed', 'Login failed (wrong email or password)', deviceOf(c));
      if (locked) events.emit('error', 'login_lockout', 'Too many failed logins: this login is locked for 60 seconds', deviceOf(c));
      // Logged without the email or the password: only a hash of where it came from.
      audit('login.failed', null, null, `source:${sha256Hex(sourceOf(c)).slice(0, 16)}`);
      return c.json(refuse('wrong_login', 'Wrong email or password'), 401); // same message for both
    }
    // An institution's name is public; a person's name is never written to the feed.
    events.emit('info', 'login_ok', `Login ok (${account.kind === 'institution' ? account.name : 'person'})`, deviceOf(c));
    return c.json({ token: await tokenFor(account), account: publicAccount(account) });
  });

  app.get('/v1/auth/me', signedIn(), (c) => c.json({ account: publicAccount(c.get('account')) }));

  // Other services check session tokens by themselves with this public key (server.ts also writes it to a file).
  app.get('/v1/auth/public-key', (c) => c.json({ publicJwk: sessionPublicJwk }));

  // Delete my account (the password is asked again as confirmation).
  //   person:      every credential they hold is revoked (reason holder_deleted), offers to them are cancelled.
  //   institution: its signing key is retired and everything it issued is revoked.
  app.post('/v1/auth/delete', signedIn(), async (c) => {
    const account = c.get('account');
    const body = z.object({ password: z.string() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success || !passwordMatches(body.data.password, account.password_hash)) return c.json(refuse('wrong_password', 'Wrong password'), 401);

    const column = account.kind === 'person' ? 'person_id' : 'institution_id';
    const reason = account.kind === 'person' ? 'holder_deleted' : 'institution_deleted';
    const rows = db.prepare(`SELECT * FROM credentials WHERE ${column} = ?`).all(account.id) as Credential[];
    db.prepare(`UPDATE credentials SET status = 'cancelled' WHERE ${column} = ? AND status = 'pending'`).run(account.id);
    await revokeCredentials(rows.filter((r) => r.status === 'active'), reason, account.id, deviceOf(c));

    if (account.kind === 'institution') {
      for (const key of db.prepare("SELECT * FROM institution_keys WHERE institution_id = ? AND state = 'Active'").all(account.id) as InstitutionKey[]) {
        db.prepare("UPDATE institution_keys SET state = 'Retired', private_jwk = '{}' WHERE institution_id = ? AND kid = ?").run(account.id, key.kid);
        await chain?.setIssuerKeyState(account.id, key.kid, 'Retired');
      }
      await chain?.setVerified(account.id, false);
    }
    db.prepare('DELETE FROM accounts WHERE id = ?').run(account.id);
    audit('account.deleted', account.id, account.kind === 'institution' ? account.id : null, account.id);
    events.emit('warn', 'account_deleted', account.kind === 'institution' ? `Institution account deleted: ${account.name}` : 'Person account deleted', deviceOf(c));
    return c.json({ ok: true, revoked: rows.filter((r) => r.status === 'active').length });
  });

  // ====================================================================================
  // Revocation list (one for the whole service)
  // ====================================================================================

  const statusList = () => db.prepare('SELECT bits_hex, version FROM status_list WHERE id = 1').get() as { bits_hex: string; version: number };

  // Mark these credentials revoked, flip their bits, bump the version, and publish the new fingerprint on the chain.
  async function revokeCredentials(rows: Credential[], reason: string, actor: string, device: string | null = null): Promise<void> {
    if (rows.length === 0) return;
    let { bits_hex: bitsHex, version } = statusList();
    for (const row of rows) {
      db.prepare("UPDATE credentials SET status = 'revoked', revoked_reason = ?, revoked_at = ? WHERE id = ?").run(reason, isoNow(), row.id);
      if (row.status_list_index !== null) bitsHex = setBit(bitsHex, row.status_list_index);
      audit('credential.revoked', actor, row.institution_id, row.id);
      events.emit('error', 'credential_revoked', `Credential ${row.id} revoked (${templateLabel(row.template)}, reason: ${reason})`, device);
    }
    version += 1;
    db.prepare('UPDATE status_list SET bits_hex = ?, version = ? WHERE id = 1').run(bitsHex, version);
    // Verifiers only accept a list whose fingerprint matches the chain.
    await chain?.anchorStatusList(statusListHash(bitsHex), version).catch(() => {});
  }

  // Public: the whole revocation list. The same file for everyone, so we cannot tell who is being checked.
  app.get('/v1/status-list', (c) => {
    const list = statusList();
    return c.json({ id: STATUS_LIST_ID, version: list.version, bitsHex: list.bits_hex });
  });

  // ====================================================================================
  // Institution: dashboard, issue, issued list, revoke
  // ====================================================================================

  const ownCredentials = (institutionId: string) => db.prepare('SELECT * FROM credentials WHERE institution_id = ? ORDER BY created_at DESC, id DESC').all(institutionId) as Credential[];
  // How an institution sees one of its own credentials. The holder's email is NOT included: the institution
  // typed it once to make the offer, and we do not hand account details back.
  const institutionView = (row: Credential) => ({
    id: row.id, template: row.template, status: row.status, fields: JSON.parse(row.fields_json), createdAt: row.created_at,
    claimedAt: row.claimed_at, revokedReason: row.revoked_reason, revokedAt: row.revoked_at, statusIndex: row.status_list_index,
  });

  app.get('/v1/institution/dashboard', signedIn('institution'), (c) => {
    const rows = ownCredentials(c.get('account').id);
    const count = (status: string) => rows.filter((r) => r.status === status).length;
    return c.json({
      institution: publicAccount(c.get('account')),
      counts: { issued: rows.filter((r) => r.claimed_at !== null).length, active: count('active'), pending: count('pending'), revoked: count('revoked'), declined: count('declined') },
    });
  });

  // "Is there a TRUE user with this email?" is the ONLY question an institution can ask about people,
  // and at most 5 times a minute, so it cannot be used to harvest who has an account.
  const lookupCounter = createRateCounter({ max: 5, windowSeconds: 60, now });
  function findPerson(c: Context<Vars>, email: string): { person: Account } | { response: Response } {
    const institution = c.get('account');
    const wait = lookupCounter.hit(institution.id);
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      return { response: c.json(refuse('too_many_lookups', `Too many email checks, try again in ${wait} seconds`), 429) };
    }
    const person = db.prepare("SELECT * FROM accounts WHERE email = ? AND kind = 'person'").get(email.trim().toLowerCase()) as Account | undefined;
    // Logged without the email that was typed.
    audit(person ? 'lookup.found' : 'lookup.not_found', institution.id, institution.id, '-');
    if (!person) events.emit('warn', 'lookup_not_found', `${institution.name}: no TRUE user with that email`, deviceOf(c));
    if (!person) return { response: c.json(refuse('no_such_user', 'No TRUE user with this email'), 404) };
    return { person };
  }

  app.post('/v1/institution/lookup', signedIn('institution'), async (c) => {
    const body = z.object({ email: z.string().max(200) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(refuse('bad_request', 'email is required'), 400);
    const found = findPerson(c, body.data.email);
    return 'response' in found ? found.response : c.json({ found: true });
  });

  // Issue: make an offer to the person with this email, using one of the templates.
  app.post('/v1/institution/offers', signedIn('institution'), async (c) => {
    const body = z.object({
      email: z.string().max(200),
      template: z.enum(Object.keys(TEMPLATES) as [string, ...string[]]),
      fields: z.record(z.string(), z.string().trim().min(1).max(200)),
    }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(refuse('bad_request', 'email, template and every field are required'), 400);
    // Exactly the template's fields: nothing missing, nothing extra.
    const wanted = TEMPLATES[body.data.template].fields;
    if (Object.keys(body.data.fields).length !== wanted.length || wanted.some((field) => !(field in body.data.fields))) {
      return c.json(refuse('bad_fields', `This template needs exactly these fields: ${wanted.join(', ')}`), 400);
    }
    const found = findPerson(c, body.data.email);
    if ('response' in found) return found.response;

    const institution = c.get('account');
    const count = (db.prepare('SELECT COUNT(*) AS n FROM credentials').get() as { n: number }).n;
    const id = `TR-${String(count + 1).padStart(4, '0')}`;
    db.prepare(`INSERT INTO credentials (id, institution_id, person_id, template, fields_json, status, claim_nonce, created_at)
                VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`).run(id, institution.id, found.person.id, body.data.template, JSON.stringify(body.data.fields), randomToken(), isoNow());
    audit('credential.offered', institution.id, institution.id, id);
    events.emit('info', 'offer_sent', `${institution.name} sent a ${templateLabel(body.data.template)} offer (${id})`, deviceOf(c));
    return c.json({ id }, 201);
  });

  app.get('/v1/institution/credentials', signedIn('institution'), (c) => {
    const status = c.req.query('status');
    const rows = ownCredentials(c.get('account').id).filter((r) => !status || r.status === status);
    return c.json({ credentials: rows.map(institutionView) });
  });

  // One of MY credentials, or nothing: another institution's id simply does not exist for me.
  const ownCredential = (c: Context<Vars>) =>
    db.prepare('SELECT * FROM credentials WHERE id = ? AND institution_id = ?').get(c.req.param('id') ?? '', c.get('account').id) as Credential | undefined;

  app.get('/v1/institution/credentials/:id', signedIn('institution'), (c) => {
    const row = ownCredential(c);
    return row ? c.json({ credential: institutionView(row) }) : c.json(refuse('unknown_credential', 'No such credential'), 404);
  });

  app.post('/v1/institution/credentials/:id/revoke', signedIn('institution'), async (c) => {
    const body = z.object({ reason: z.enum(REVOKE_REASONS) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(refuse('bad_request', `reason must be one of: ${REVOKE_REASONS.join(', ')}`), 400);
    const row = ownCredential(c);
    if (!row) return c.json(refuse('unknown_credential', 'No such credential'), 404);
    if (row.status !== 'active') return c.json(refuse('not_active', 'Only an active credential can be revoked'), 409);
    await revokeCredentials([row], body.data.reason, c.get('account').id, deviceOf(c));
    return c.json({ ok: true });
  });

  // Withdraw an offer the person has not answered yet.
  app.post('/v1/institution/credentials/:id/cancel', signedIn('institution'), (c) => {
    const row = ownCredential(c);
    if (!row) return c.json(refuse('unknown_credential', 'No such credential'), 404);
    if (row.status !== 'pending') return c.json(refuse('not_pending', 'Only a pending offer can be cancelled'), 409);
    db.prepare("UPDATE credentials SET status = 'cancelled' WHERE id = ?").run(row.id);
    audit('offer.cancelled', c.get('account').id, row.institution_id, row.id);
    events.emit('warn', 'offer_cancelled', `Offer ${row.id} cancelled by ${c.get('account').name}`, deviceOf(c));
    return c.json({ ok: true });
  });

  // Activity log for this institution: ids only.
  app.get('/v1/institution/activity', signedIn('institution'), (c) =>
    c.json({ events: db.prepare("SELECT * FROM audit_events WHERE institution_id = ? AND type NOT LIKE 'lookup.%' ORDER BY id DESC LIMIT 200").all(c.get('account').id) as AuditEvent[] }),
  );

  // ====================================================================================
  // Person: offers
  // ====================================================================================

  // One of the offers made to ME that is still open, or nothing.
  const myOffer = (c: Context<Vars>) =>
    db.prepare("SELECT * FROM credentials WHERE id = ? AND person_id = ? AND status = 'pending'").get(c.req.param('id') ?? '', c.get('account').id) as Credential | undefined;

  app.get('/v1/me/offers', signedIn('person'), (c) => {
    const rows = db.prepare("SELECT * FROM credentials WHERE person_id = ? AND status = 'pending' ORDER BY created_at DESC").all(c.get('account').id) as Credential[];
    return c.json({
      offers: rows.map((row) => {
        const institution = db.prepare('SELECT * FROM accounts WHERE id = ?').get(row.institution_id) as Account | undefined;
        return {
          id: row.id, template: row.template, fields: JSON.parse(row.fields_json), createdAt: row.created_at,
          // The app also reads the verified flag from the chain; this copy is for a first quick display.
          institution: { id: row.institution_id, name: institution?.name ?? 'Deleted institution', verified: institution?.verified === 1 },
        };
      }),
    });
  });

  // Accept, step 1: get the nonce the wallet must sign to prove it owns its key.
  app.post('/v1/me/offers/:id/accept', signedIn('person'), (c) => {
    const row = myOffer(c);
    if (!row) return c.json(refuse('unknown_offer', 'No such open offer'), 404);
    events.emit('success', 'offer_accepted', `Offer ${row.id} accepted (${templateLabel(row.template)})`, deviceOf(c));
    return c.json({ nonce: row.claim_nonce, issuerId: row.institution_id });
  });

  // Accept, step 2: the wallet sends its proof (which carries its public key) and gets the signed credential.
  app.post('/v1/me/offers/:id/claim', signedIn('person'), async (c) => {
    const body = z.object({ proof: z.string() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(refuse('bad_request', 'proof is required'), 400);
    const row = myOffer(c);
    if (!row) return c.json(refuse('unknown_offer', 'No such open offer'), 404);
    const institution = db.prepare('SELECT * FROM accounts WHERE id = ?').get(row.institution_id) as Account | undefined;
    const key = db.prepare("SELECT * FROM institution_keys WHERE institution_id = ? AND state = 'Active'").get(row.institution_id) as InstitutionKey | undefined;
    if (!institution || !key) return c.json(refuse('issuer_gone', 'This institution can no longer issue'), 409);

    // The proof must be signed over THIS offer's nonce, by the key it carries.
    const holderPublicJwk = await verifyHolderProof(body.data.proof, { nonce: row.claim_nonce, audience: row.institution_id });
    if (!holderPublicJwk) return c.json(refuse('bad_holder_proof', 'Proof of key ownership failed'), 400);

    // Take the offer FIRST, and only continue if this request was the one that took it (no double issue).
    const max = db.prepare('SELECT MAX(status_list_index) AS m FROM credentials').get() as { m: number | null };
    const statusIndex = max.m === null ? 0 : max.m + 1; // every credential gets its own position in the list
    const taken = db.prepare("UPDATE credentials SET status = 'active', claimed_at = ?, status_list_index = ? WHERE id = ? AND status = 'pending'").run(isoNow(), statusIndex, row.id);
    if (taken.changes !== 1) return c.json(refuse('unknown_offer', 'No such open offer'), 404);

    const credential = await issueCredential({
      issuerId: institution.id,
      issuerPrivateJwk: JSON.parse(key.private_jwk),
      keyId: key.kid,
      holderPublicJwk,
      statusIndex,
      statusListUrl: STATUS_LIST_URL,
      type: row.template,
      validDays: CREDENTIAL_VALID_DAYS,
      claims: JSON.parse(row.fields_json), // every field becomes its own selectively disclosable claim
    });
    audit('credential.accepted', c.get('account').id, row.institution_id, row.id);
    events.emit('success', 'credential_claimed', `Credential ${row.id} claimed (${templateLabel(row.template)} from ${institution.name})`, deviceOf(c));
    return c.json({ credential, credentialId: row.id, issuerId: institution.id, issuerName: institution.name }, 201);
  });

  app.post('/v1/me/offers/:id/reject', signedIn('person'), (c) => {
    const row = myOffer(c);
    if (!row) return c.json(refuse('unknown_offer', 'No such open offer'), 404);
    db.prepare("UPDATE credentials SET status = 'declined' WHERE id = ?").run(row.id);
    audit('offer.declined', c.get('account').id, row.institution_id, row.id);
    events.emit('warn', 'offer_declined', `Offer ${row.id} declined (${templateLabel(row.template)})`, deviceOf(c));
    return c.json({ ok: true });
  });

  // ====================================================================================
  // Start-up and operator helpers (used by server.ts and scripts, not reachable over HTTP)
  // ====================================================================================

  // The local chain starts empty on every run, but this database persists: publish whatever the chain is missing.
  async function publishToChain(isOnChain: (institutionId: string, keyId: string) => Promise<string | null>, anchoredVersion: number) {
    for (const institution of db.prepare("SELECT * FROM accounts WHERE kind = 'institution'").all() as Account[]) {
      for (const key of db.prepare('SELECT * FROM institution_keys WHERE institution_id = ?').all(institution.id) as InstitutionKey[]) {
        const state = await isOnChain(institution.id, key.kid);
        if (state === null) {
          await chain?.registerInstitution(institution.id, institution.name);
          await chain?.addIssuerKey(institution.id, key.kid, JSON.parse(key.public_jwk));
        }
        if (key.state !== 'Active' && state !== key.state) await chain?.setIssuerKeyState(institution.id, key.kid, key.state);
      }
      await chain?.setVerified(institution.id, institution.verified === 1);
    }
    const list = statusList();
    if (list.version === 0) {
      // First ever start: publish the empty list as version 1 so verifiers have something to compare against.
      list.version = 1;
      db.prepare('UPDATE status_list SET version = 1 WHERE id = 1').run();
    }
    if (anchoredVersion < list.version) await chain?.anchorStatusList(statusListHash(list.bits_hex), list.version);
  }

  return { app, publishToChain, sessionPublicJwk };
}

// Operator action behind "npm run verify-institution -- <email>": mark an institution verified in the
// database and in the registry. Returns the institution id, or null if no institution has that email.
export async function verifyInstitution(db: DatabaseSync, email: string, setVerifiedOnChain: (institutionId: string) => Promise<unknown>): Promise<string | null> {
  const account = db.prepare("SELECT * FROM accounts WHERE email = ? AND kind = 'institution'").get(email.trim().toLowerCase()) as Account | undefined;
  if (!account) return null;
  db.prepare('UPDATE accounts SET verified = 1 WHERE id = ?').run(account.id);
  await setVerifiedOnChain(account.id);
  return account.id;
}
