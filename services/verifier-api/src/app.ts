// Verifier API routes.
// Hard rule: nothing in this file calls the issuer's API or database. A presentation is checked using
// only its own signatures, the issuer key from the chain registry, and our cached copy of the revocation list.
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { LOAD_TEST_VERIFIER_ID, REGISTER_SERVICE_ID, TEMPLATES, URLS, isAllowedOrigin, createEventLog, eventQuery, templateLabel } from '@true/shared';
import { verifyPresentation, verifySession, signRequest, randomToken, sha256Hex, type IssuerKeyInfo, type Jwk, type Session } from '@true/credentials';
import { DEMO_VERIFIERS, type VerifierRow, type RequestRow, type RegisterRow, type VisitRow, type DenialRow } from './db.ts';
import { buildSteps } from './steps.ts';
import {
  addAuditEvent, deleteLoadTestRequests, exportState, purgeOldVisits, saveDenial, saveRegister, saveVisit, getStatusBits, isRevoked, mergeState, setRevoked, toShared, type SharedState,
} from './sync.ts';

const REQUEST_MINUTES = 5;
// What this build of the verifier can do. The app compares it with what it needs, to detect servers running older code.
export const FEATURES = ['registers', 'visits'];
const REGISTER_REQUEST_MINUTES = 2; // a register's QR is fresh every time and short-lived

// Looks up an issuer key (public key + state) in the chain registry. Null if it is not there.
export type IssuerKeyLookup = (issuerId: string, keyId: string) => Promise<IssuerKeyInfo | null> | IssuerKeyInfo | null;

const refuse = (code: string, message: string) => ({ error: { code, message } });

// Settings for running two instances that share state. All optional, so a single instance still works.
export type InstanceOptions = {
  instance?: string; // name shown in the status panel, e.g. "1"
  internalKey?: string; // secret both instances know; protects /internal/*
  sendToPeer?: (state: SharedState) => Promise<unknown>; // delivers changes to the other instances
  syncedAtStart?: boolean;
  verifierKeys?: Record<string, Jwk>;
  // The accounts service's PUBLIC key, used to check session tokens here without calling that service.
  getSessionKey?: () => Jwk | null;
  // True when a request reached us from this machine itself (the front door). Only then do we believe the
  // "x-device" header, which carries the front door's short hashed label of the phone that is calling.
  trustsDeviceHeader?: (c: Context) => boolean;
  visitRetentionDays?: number; // how long visitor-list rows are kept (default 30) // verifier id => private key used to sign that verifier's requests // true if this instance pulled the full state from a peer when it started
};

export function createVerifierApp(db: DatabaseSync, getIssuerKey: IssuerKeyLookup, options: InstanceOptions = {}) {
  const app = new Hono();
  app.use('*', cors({ origin: (origin) => (isAllowedOrigin(origin) ? origin : null) }));
  // The address the caller used to reach the front door (for example http://192.168.1.20:4000). Links we hand
  // out (in QR codes and signed requests) are built from it, so a phone gets an address that works for a phone.
  const publicOrigin = (c: { req: { header: (name: string) => string | undefined } }) => c.req.header('x-public-origin') ?? URLS.verifierApi;
  app.notFound((c) => c.json(refuse('unknown_route', 'This verifier server does not have that address. If the app is newer than the server, restart "npm run dev".'), 404));
  const instance = options.instance ?? '1';
  let lastSyncedAt: number | null = options.syncedAtStart ? Date.now() : null;

  // ---------- live event feed for the Control Room (in memory, no personal data: see packages/shared/src/events.ts) ----------
  const events = createEventLog(`verifier-${instance}`);
  const deviceOf = (c: Context) => (options.trustsDeviceHeader?.(c) ? c.req.header('x-device') || null : null);
  if (options.syncedAtStart) events.emit('success', 'caught_up', `Instance ${instance} caught up from a peer`);
  // Who a request is for, as shown in the feed: the register's name, or the demo verifier's name.
  const checkerName = (request: RequestRow) => {
    const register = request.register_id ? (db.prepare('SELECT * FROM registers WHERE id = ?').get(request.register_id) as RegisterRow | undefined) : undefined;
    return register ? `register "${register.name}"` : getVerifier(request.verifier_id)?.name ?? 'unknown verifier';
  };

  const getVerifier = (id: string) => db.prepare('SELECT * FROM verifiers WHERE id = ?').get(id) as VerifierRow | undefined;
  const getRequest = (id: string) => db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as RequestRow | undefined;

  // Send a change to the other instance. If it is down we carry on; it catches up when it restarts.
  async function share(state: SharedState) {
    if (!options.sendToPeer) return;
    try {
      await options.sendToPeer(state);
      lastSyncedAt = Date.now();
    } catch { /* peer is down */ }
  }

  // Record an audit event and share the request's new state. No claim values are logged or shared.
  async function recordAndShare(type: string, requestId: string) {
    const request = getRequest(requestId)!;
    // Synthetic load-test requests are shared (so any instance can answer a poll) but kept out of the audit log.
    if (request.verifier_id === LOAD_TEST_VERIFIER_ID) return share({ requests: [toShared(request)] });
    const event = { id: randomToken(), ts: new Date().toISOString(), type, request_id: requestId, instance };
    addAuditEvent(db, event);
    await share({ requests: [toShared(request)], auditEvents: [event] });
  }

  // Saves the final outcome. "AND state = 'pending'" means a request can be answered exactly once,
  // which is what makes a replayed presentation fail.
  function finish(id: string, state: 'verified' | 'denied', result: object): boolean {
    const done = db.prepare("UPDATE requests SET state = ?, result_json = ?, updated_at = ? WHERE id = ? AND state = 'pending'").run(
      state, JSON.stringify(result), new Date().toISOString(), id,
    );
    return done.changes === 1;
  }

  // ---------- instance health and state sharing ----------

  // Simple counters for the status cards: calls served, calls that failed on our side, and time since start.
  const startedAt = Date.now();
  let served = 0;
  let failures = 0;
  app.use('/v1/*', async (c, next) => {
    await next();
    served += 1;
    if (c.res.status >= 500) failures += 1;
  });

  app.get('/health', (c) =>
    c.json({ instance, alive: true, lastSyncedAt, served, failures, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), features: FEATURES }),
  );

  // Everything under /internal needs the shared secret. Only the other instance has it.
  app.use('/internal/*', async (c, next) => {
    if (!options.internalKey || c.req.header('x-internal-key') !== options.internalKey) {
      return c.json(refuse('forbidden', 'Internal key missing or wrong'), 403);
    }
    await next();
  });

  // The other instance pushes its changes here. Safe to receive the same data twice.
  app.post('/internal/sync', async (c) => {
    mergeState(db, await c.req.json());
    lastSyncedAt = Date.now();
    return c.json({ ok: true });
  });

  // The front door records things it decided itself here (for example "a source was blocked").
  // "subject" is a hashed identifier, never an IP address or a name.
  app.post('/internal/audit', async (c) => {
    const body = z.object({ type: z.string(), subject: z.string() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(refuse('bad_request', 'type and subject are required'), 400);
    const event = { id: randomToken(), ts: new Date().toISOString(), type: body.data.type, request_id: body.data.subject, instance };
    addAuditEvent(db, event);
    await share({ auditEvents: [event] });
    return c.json({ ok: true });
  });

  // The front door collects our events from here (shared secret needed, like everything under /internal).
  app.get('/internal/events', (c) => {
    const { after, limit } = eventQuery((name) => c.req.query(name));
    return c.json(events.page(after, limit));
  });

  // The other instance reads everything from here when it restarts.
  app.get('/internal/state', (c) => c.json(exportState(db)));

  // Mark a status-list position as revoked on this instance, then tell the other one.
  // (Stand-in for the scheduled status-list download that arrives with M2.)
  app.post('/internal/status/revoke', async (c) => {
    const body = z.object({ index: z.number().int().min(0) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(refuse('bad_request', 'index is required'), 400);
    setRevoked(db, body.data.index);
    await share({ statusBitsHex: getStatusBits(db) });
    return c.json({ ok: true });
  });

  app.get('/v1/status/:index', (c) => c.json({ index: Number(c.req.param('index')), revoked: isRevoked(db, Number(c.req.param('index'))) }));

  app.get('/v1/audit/events', (c) => c.json({ events: db.prepare('SELECT * FROM audit_events ORDER BY ts').all() }));

  // The verifier screen lists who it can act as (three demo verifiers).
  app.get('/v1/verifiers', (c) => {
    const rows = db.prepare('SELECT * FROM verifiers WHERE id NOT IN (?, ?) ORDER BY name').all(LOAD_TEST_VERIFIER_ID, REGISTER_SERVICE_ID) as VerifierRow[];
    return c.json({
      verifiers: rows.map((v) => ({ id: v.id, name: v.name, purpose: v.purpose, claims: JSON.parse(v.allowed_claims_json) })),
    });
  });

  // ---------- registers (a person's saved checks) ----------

  // Who is calling? The session token is checked locally with the accounts service's public key.
  async function personFrom(c: { req: { header: (name: string) => string | undefined } }): Promise<Session | null> {
    const key = options.getSessionKey?.();
    const session = key ? await verifySession((c.req.header('authorization') ?? '').replace(/^Bearer /, ''), key) : null;
    return session?.kind === 'person' ? session : null;
  }
  const notSignedIn = refuse('not_signed_in', 'Log in as a person first');
  const liveRegister = (id: string) => db.prepare('SELECT * FROM registers WHERE id = ? AND deleted = 0').get(id) as RegisterRow | undefined;
  const registerView = (r: RegisterRow) => ({
    id: r.id, name: r.name, purpose: r.purpose, issuerId: r.issuer_id, issuerName: r.issuer_name, type: r.type, fields: JSON.parse(r.fields_json) as string[], createdAt: r.created_at,
  });
  async function storeRegister(register: RegisterRow) {
    saveRegister(db, register);
    await share({ registers: [register] });
  }

  app.get('/v1/registers', async (c) => {
    const person = await personFrom(c);
    if (!person) return c.json(notSignedIn, 401);
    const rows = db.prepare('SELECT * FROM registers WHERE owner_id = ? AND deleted = 0 ORDER BY created_at DESC').all(person.sub) as RegisterRow[];
    return c.json({ registers: rows.map(registerView) });
  });

  // Set up ONCE: a name, a purpose, ONE institution, ONE ID type, and the fields (only from that type's template).
  app.post('/v1/registers', async (c) => {
    const person = await personFrom(c);
    if (!person) return c.json(notSignedIn, 401);
    const body = z.object({
      name: z.string().trim().min(2).max(60), purpose: z.string().trim().min(2).max(120),
      issuerId: z.string().startsWith('inst:'), issuerName: z.string().trim().min(1).max(80),
      type: z.enum(Object.keys(TEMPLATES) as [string, ...string[]]), fields: z.array(z.string()).min(1),
    }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(refuse('bad_request', 'name, purpose, institution, ID type and at least one field are required'), 400);
    const allowed = TEMPLATES[body.data.type].fields;
    if (body.data.fields.some((field) => !allowed.includes(field))) return c.json(refuse('bad_fields', `Fields must come from the ${body.data.type} template: ${allowed.join(', ')}`), 400);
    const now = new Date().toISOString();
    const register: RegisterRow = {
      id: `reg:${randomToken().slice(0, 12)}`, owner_id: person.sub, owner_name: person.name, name: body.data.name, purpose: body.data.purpose,
      issuer_id: body.data.issuerId, issuer_name: body.data.issuerName, type: body.data.type, fields_json: JSON.stringify([...new Set(body.data.fields)]),
      created_at: now, updated_at: now, deleted: 0,
    };
    await storeRegister(register);
    events.emit('info', 'register_created', `Register "${register.name}" created (accepts ${templateLabel(register.type)} from ${register.issuer_name})`, deviceOf(c));
    return c.json({ register: registerView(register) }, 201);
  });

  // Delete one register (its QR codes stop working at once), or all of mine (used when the account is deleted).
  app.post('/v1/registers/:id/delete', async (c) => {
    const person = await personFrom(c);
    if (!person) return c.json(notSignedIn, 401);
    const mine = c.req.param('id') === 'all'
      ? (db.prepare('SELECT * FROM registers WHERE owner_id = ? AND deleted = 0').all(person.sub) as RegisterRow[])
      : [liveRegister(c.req.param('id'))].filter((r): r is RegisterRow => r?.owner_id === person.sub);
    if (mine.length === 0 && c.req.param('id') !== 'all') return c.json(refuse('unknown_register', 'No such register'), 404);
    for (const register of mine) {
      await storeRegister({ ...register, deleted: 1, updated_at: new Date().toISOString() });
      events.emit('warn', 'register_deleted', `Register "${register.name}" deleted`, deviceOf(c));
    }
    return c.json({ ok: true, deleted: mine.length });
  });

  // ---------- visitor list ----------

  const retentionDays = options.visitRetentionDays ?? 30;

  // Valid / Revoked / Issuer key compromised, looked up NOW from our revocation list and the chain registry.
  // It is never stored, so an ID revoked after a visit shows as Revoked the next time the list is read.
  async function liveStatus(visit: VisitRow): Promise<'valid' | 'revoked' | 'key_compromised'> {
    if (isRevoked(db, visit.status_index)) return 'revoked';
    const key = await getIssuerKey(visit.issuer, visit.key_id);
    return key?.state === 'Compromised' ? 'key_compromised' : 'valid';
  }

  // Only the register's OWNER may read its visitor list.
  app.get('/v1/registers/:id/visits', async (c) => {
    const person = await personFrom(c);
    if (!person) return c.json(notSignedIn, 401);
    const register = liveRegister(c.req.param('id'));
    if (!register) return c.json(refuse('unknown_register', 'No such register'), 404);
    if (register.owner_id !== person.sub) return c.json(refuse('forbidden', 'Only the owner of this register can see its visitors'), 403);

    purgeOldVisits(db, retentionDays);
    const visits = db.prepare('SELECT * FROM visits WHERE register_id = ? ORDER BY verified_at').all(register.id) as VisitRow[];
    // Group the visits by credential: one line per person's ID.
    const groups = new Map<string, VisitRow[]>();
    for (const visit of visits) groups.set(visit.credential_id, [...(groups.get(visit.credential_id) ?? []), visit]);
    const visitors = await Promise.all([...groups.entries()].map(async ([credentialId, rows], index) => {
      const latest = rows.at(-1)!;
      const fields = JSON.parse(latest.fields_json) as Record<string, unknown>;
      return {
        credentialId,
        name: typeof fields.name === 'string' ? fields.name : `Visitor #${index + 1}`, // a name only if this register asked for it
        visits: rows.length,
        firstVerifiedAt: rows[0].verified_at,
        lastVerifiedAt: latest.verified_at,
        status: await liveStatus(latest),
        issuer: latest.issuer,
        issuerName: register.issuer_name,
        type: latest.type,
        fields,
        servedBy: [...new Set(rows.map((row) => row.instance))],
      };
    }));
    const denials = db.prepare('SELECT code, COUNT(*) AS n FROM register_denials WHERE register_id = ? GROUP BY code').all(register.id) as { code: string; n: number }[];
    return c.json({
      register: registerView(register),
      visitors: visitors.sort((a, b) => b.lastVerifiedAt.localeCompare(a.lastVerifiedAt)),
      denied: { total: denials.reduce((sum, d) => sum + d.n, 0), byReason: Object.fromEntries(denials.map((d) => [d.code, d.n])) },
      retentionDays,
    });
  });

  // The QR icon: a FRESH request every time (new nonce, 2 minutes), asking for the register's stored fields.
  app.post('/v1/registers/:id/requests', async (c) => {
    const person = await personFrom(c);
    if (!person) return c.json(notSignedIn, 401);
    const register = liveRegister(c.req.param('id'));
    if (!register || register.owner_id !== person.sub) return c.json(refuse('unknown_register', 'No such register'), 404);
    // A request may ask for fewer fields than the register was set up with, never for more.
    const stored = JSON.parse(register.fields_json) as string[];
    const body = z.object({ claims: z.array(z.string()).min(1).optional() }).safeParse(await c.req.json().catch(() => ({})));
    const claims = body.success && body.data.claims ? body.data.claims : stored;
    if (claims.some((claim) => !stored.includes(claim))) events.emit('warn', 'beyond_register', `Over-ask refused: a request for register "${register.name}" asked for more than it was set up with`, deviceOf(c));
    if (claims.some((claim) => !stored.includes(claim))) return c.json(refuse('beyond_register', 'A request cannot ask for fields the register was not set up with'), 400);

    const id = randomToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + REGISTER_REQUEST_MINUTES * 60_000).toISOString();
    db.prepare('INSERT INTO requests (id, verifier_id, claims_json, nonce, created_at, expires_at, updated_at, register_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, REGISTER_SERVICE_ID, JSON.stringify(claims), randomToken(), now.toISOString(), expiresAt, now.toISOString(), register.id,
    );
    await recordAndShare('request.created', id);
    events.emit('info', 'request_created', `Request created for register "${register.name}"`, deviceOf(c));
    const requestUri = `${publicOrigin(c)}/v1/requests/${id}/object`;
    return c.json({ requestId: id, requestUri, walletUrl: `${URLS.app}/#/consent?request_uri=${encodeURIComponent(requestUri)}`, expiresAt }, 201);
  });

  // Create a presentation request: which claims, plus a fresh one-time nonce.
  app.post('/v1/requests', async (c) => {
    // "claims" is optional: by default a verifier asks for exactly what it is registered for.
    // Asking for more is allowed here on purpose, so the demo can show the wallet flagging it.
    const body = z.object({ verifierId: z.string(), claims: z.array(z.string()).min(1).optional() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(refuse('bad_request', 'verifierId is required'), 400);
    const verifier = getVerifier(body.data.verifierId);
    if (!verifier) return c.json(refuse('unknown_verifier', 'No such verifier'), 404);
    const claimsJson = body.data.claims ? JSON.stringify(body.data.claims) : verifier.allowed_claims_json;

    const id = randomToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + REQUEST_MINUTES * 60_000).toISOString();
    db.prepare('INSERT INTO requests (id, verifier_id, claims_json, nonce, created_at, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id, verifier.id, claimsJson, randomToken(), now.toISOString(), expiresAt, now.toISOString(),
    );
    await recordAndShare('request.created', id);
    // Not one line per synthetic load-test request: the load test writes a single summary line.
    if (verifier.id !== LOAD_TEST_VERIFIER_ID) {
      const allowed = JSON.parse(verifier.allowed_claims_json) as string[];
      const overAsk = (JSON.parse(claimsJson) as string[]).some((claim) => !allowed.includes(claim));
      if (DEMO_VERIFIERS.find((v) => v.id === verifier.id)?.registered === false) events.emit('warn', 'unregistered_verifier', `Request created by an UNREGISTERED verifier: ${verifier.name}`, deviceOf(c));
      else if (overAsk) events.emit('warn', 'over_ask', `Over-ask: ${verifier.name} created a request for more than it is registered for`, deviceOf(c));
      else events.emit('info', 'request_created', `Request created for ${verifier.name}`, deviceOf(c));
    }
    const requestUri = `${publicOrigin(c)}/v1/requests/${id}/object`;
    // The QR code is a link that opens the wallet and tells it where to fetch the request.
    const walletUrl = `${URLS.app}/#/consent?request_uri=${encodeURIComponent(requestUri)}`;
    return c.json({ requestId: id, requestUri, walletUrl, expiresAt }, 201);
  });

  // Wallet: fetch what is being asked. "signedRequest" is the same content signed with the verifier's key;
  // the wallet trusts only that, after checking it against the chain registry.
  app.get('/v1/requests/:id/object', async (c) => {
    const request = getRequest(c.req.param('id'));
    if (!request) return c.json(refuse('unknown_request', 'No such request'), 404);
    const verifier = getVerifier(request.verifier_id)!;
    // A request from a register carries the register's name, owner and its ONE institution and ID type.
    const register = request.register_id ? liveRegister(request.register_id) : undefined;
    if (request.register_id && !register) return c.json(refuse('register_deleted', 'This register was deleted'), 404);
    const content = {
      ...(register ? { register: { id: register.id, name: register.name, owner: register.owner_name, issuerId: register.issuer_id, issuerName: register.issuer_name, type: register.type, retentionDays } } : {}),
      requestId: request.id,
      verifierId: verifier.id,
      purpose: register?.purpose ?? verifier.purpose,
      claims: JSON.parse(request.claims_json) as string[],
      nonce: request.nonce,
      responseUri: `${publicOrigin(c)}/v1/requests/${request.id}/response`,
    };
    const key = options.verifierKeys?.[verifier.id];
    const signedRequest = key ? await signRequest(content, key, new Date(request.expires_at)) : null;
    return c.json({ ...content, verifierName: verifier.name, expiresAt: request.expires_at, signedRequest });
  });

  // Wallet: send the presentation, or tell us the user declined.
  app.post('/v1/requests/:id/response', async (c) => {
    const body = z
      .object({ presentation: z.string().optional(), declined: z.boolean().optional() })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(refuse('bad_request', 'presentation or declined is required'), 400);

    const request = getRequest(c.req.param('id'));
    if (!request) return c.json(refuse('unknown_request', 'No such request'), 404);
    // Already answered once: this is a replay (or a double click). Refuse and do not change the stored result.
    if (request.state !== 'pending') return c.json(refuse('request_already_answered', 'This request was already answered'), 409);
    if (new Date(request.expires_at) < new Date()) {
      db.prepare("UPDATE requests SET state = 'expired' WHERE id = ? AND state = 'pending'").run(request.id);
      events.emit('error', 'request_expired', `Denied at ${checkerName(request)}: request_expired`, deviceOf(c));
      return c.json(refuse('request_expired', 'This request has expired'), 410);
    }

    if (body.data.declined || !body.data.presentation) {
      finish(request.id, 'denied', { code: 'user_declined', message: 'The holder declined to share' });
      await recordAndShare('consent.denied', request.id);
      events.emit('warn', 'user_declined', `The holder declined to share with ${checkerName(request)}`, deviceOf(c));
      return c.json({ state: 'denied', code: 'user_declined' });
    }

    const result = await verifyPresentation({
      presentation: body.data.presentation,
      nonce: request.nonce,
      audience: request.verifier_id,
      getIssuerKey,
    });

    // Policy check: every claim we asked for must actually have been disclosed.
    const wanted = JSON.parse(request.claims_json) as string[];
    let outcome: { state: 'verified' | 'denied'; result: object };
    // The pin, enforced HERE on the server: a register accepts ONE institution and ONE ID type,
    // even if another credential happens to carry fields with the same names and values.
    const register = request.register_id ? liveRegister(request.register_id) : undefined;
    if (!result.ok) {
      outcome = { state: 'denied', result: { code: result.code, message: result.message } };
    } else if (request.register_id && !register) {
      outcome = { state: 'denied', result: { code: 'register_deleted', message: 'This register was deleted' } };
    } else if (register && result.issuer !== register.issuer_id) {
      outcome = { state: 'denied', result: { code: 'wrong_issuer', message: `This register only accepts IDs from ${register.issuer_name}` } };
    } else if (register && result.type !== register.type) {
      outcome = { state: 'denied', result: { code: 'wrong_credential_type', message: `This register only accepts a ${TEMPLATES[register.type].label}` } };
    } else if (result.statusIndex === null) {
      outcome = { state: 'denied', result: { code: 'missing_status', message: 'The credential has no revocation index' } };
    } else if (isRevoked(db, result.statusIndex)) {
      // Signatures are fine, but the issuer has cancelled this credential. Read from our cached list, not from the issuer.
      outcome = { state: 'denied', result: { code: 'revoked', message: 'Revoked: the issuer has cancelled this credential' } };
    } else if (wanted.some((claim) => !(claim in result.claims))) {
      outcome = { state: 'denied', result: { code: 'missing_claims', message: 'A requested claim was not disclosed' } };
    } else if (wanted.some((claim) => result.claims[claim] === false)) {
      // A genuine credential that honestly answers "No" (e.g. age_over_18: false) proves the person does NOT qualify.
      outcome = { state: 'denied', result: { code: 'requirement_not_met', message: 'The credential is genuine but answers No' } };
    } else {
      outcome = { state: 'verified', result: { issuer: result.issuer, claims: result.claims } };
    }

    // Add what the wallet shows on its "Verifying" and "Cryptographic details" screens:
    // one line per check, which issuer key signed, and when we checked. None of it is personal data.
    const failureCode = outcome.state === 'verified' ? null : (outcome.result as { code: string }).code;
    outcome.result = { ...outcome.result, steps: buildSteps(failureCode), keyId: result.keyId ?? null, verifiedAt: new Date().toISOString() };

    if (!finish(request.id, outcome.state, outcome.result)) {
      return c.json(refuse('request_already_answered', 'This request was already answered'), 409);
    }
    await recordAndShare(outcome.state === 'verified' ? 'presentation.verified' : 'presentation.failed', request.id);
    // The feed line carries the checker's name and a reason code. Never what was disclosed.
    if (outcome.state === 'verified') events.emit('success', 'verified', `Verified at ${checkerName(request)} · served by instance ${instance}`, deviceOf(c));
    else events.emit('error', failureCode ?? 'denied', `Denied at ${checkerName(request)}: ${failureCode} · served by instance ${instance}`, deviceOf(c));

    // Visitor list. A successful check through a register is kept: only the fields the register asked for.
    // A refused check keeps NO details: just the reason code and the time.
    if (register && outcome.state === 'verified' && result.ok && result.statusIndex !== null) {
      const visit: VisitRow = {
        id: randomToken(), register_id: register.id,
        credential_id: sha256Hex(`${result.issuer}|${result.statusIndex}`).slice(0, 16),
        issuer: result.issuer, key_id: result.keyId, status_index: result.statusIndex, type: result.type,
        fields_json: JSON.stringify(Object.fromEntries(wanted.map((claim) => [claim, result.claims[claim]]))),
        verified_at: new Date().toISOString(), instance,
      };
      saveVisit(db, visit);
      await share({ visits: [visit] });
    } else if (register && outcome.state === 'denied') {
      const denial: DenialRow = { id: randomToken(), register_id: register.id, code: (outcome.result as { code: string }).code, at: new Date().toISOString() };
      saveDenial(db, denial);
      await share({ denials: [denial] });
    }
    return c.json({ state: outcome.state, ...outcome.result });
  });

  // Verifier screen polls this once a second to update live.
  app.get('/v1/requests/:id', (c) => {
    const request = getRequest(c.req.param('id'));
    if (!request) return c.json(refuse('unknown_request', 'No such request'), 404);
    const expired = request.state === 'pending' && new Date(request.expires_at) < new Date();
    return c.json({
      requestId: request.id,
      verifierId: request.verifier_id,
      state: expired ? 'expired' : request.state,
      result: request.result_json ? JSON.parse(request.result_json) : null,
    });
  });

  // End of a load test: delete its synthetic requests here and on every peer,
  // and write ONE summary line to the audit log (counts only).
  app.post('/v1/load-test/cleanup', async (c) => {
    const body = z.object({ requests: z.number().int(), failures: z.number().int() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(refuse('bad_request', 'requests and failures are required'), 400);
    deleteLoadTestRequests(db);
    const summary = `load-test: ${body.data.requests} requests, ${body.data.failures} failures`;
    const event = { id: randomToken(), ts: new Date().toISOString(), type: 'loadtest.summary', request_id: summary, instance };
    addAuditEvent(db, event);
    await share({ deleteLoadTest: true, auditEvents: [event] });
    return c.json({ ok: true });
  });

  // Stateless check for partner back ends (Convergence Round): they supply their own nonce and audience.
  app.post('/v1/verify', async (c) => {
    const body = z
      .object({ presentation: z.string(), nonce: z.string(), audience: z.string() })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(refuse('bad_request', 'presentation, nonce and audience are required'), 400);
    const result = await verifyPresentation({ ...body.data, getIssuerKey });
    if (result.ok && result.statusIndex !== null && isRevoked(db, result.statusIndex)) {
      return c.json({ ok: false, code: 'revoked', message: 'Revoked: the issuer has cancelled this credential' });
    }
    return c.json(result);
  });

  return app;
}
