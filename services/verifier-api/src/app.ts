// Verifier API routes.
// Hard rule: nothing in this file calls the issuer's API or database. A presentation is checked using
// only its own signatures, the issuer key from the chain registry, and our cached copy of the revocation list.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { LOAD_TEST_VERIFIER_ID, URLS } from '@true/shared';
import { verifyPresentation, signRequest, randomToken, type IssuerKeyInfo, type Jwk } from '@true/credentials';
import type { VerifierRow, RequestRow } from './db.ts';
import { buildSteps } from './steps.ts';
import {
  addAuditEvent, deleteLoadTestRequests, exportState, getStatusBits, isRevoked, mergeState, setRevoked, toShared, type SharedState,
} from './sync.ts';

const REQUEST_MINUTES = 5;

// Looks up an issuer key (public key + state) in the chain registry. Null if it is not there.
export type IssuerKeyLookup = (issuerId: string, keyId: string) => Promise<IssuerKeyInfo | null> | IssuerKeyInfo | null;

const refuse = (code: string, message: string) => ({ error: { code, message } });

// Settings for running two instances that share state. All optional, so a single instance still works.
export type InstanceOptions = {
  instance?: string; // name shown in the status panel, e.g. "1"
  internalKey?: string; // secret both instances know; protects /internal/*
  sendToPeer?: (state: SharedState) => Promise<unknown>; // delivers changes to the other instances
  syncedAtStart?: boolean;
  verifierKeys?: Record<string, Jwk>; // verifier id => private key used to sign that verifier's requests // true if this instance pulled the full state from a peer when it started
};

export function createVerifierApp(db: DatabaseSync, getIssuerKey: IssuerKeyLookup, options: InstanceOptions = {}) {
  const app = new Hono();
  app.use('*', cors());
  const instance = options.instance ?? '1';
  let lastSyncedAt: number | null = options.syncedAtStart ? Date.now() : null;

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
    c.json({ instance, alive: true, lastSyncedAt, served, failures, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) }),
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
    const rows = db.prepare('SELECT * FROM verifiers WHERE id != ? ORDER BY name').all(LOAD_TEST_VERIFIER_ID) as VerifierRow[];
    return c.json({
      verifiers: rows.map((v) => ({ id: v.id, name: v.name, purpose: v.purpose, claims: JSON.parse(v.allowed_claims_json) })),
    });
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
    const requestUri = `${URLS.verifierApi}/v1/requests/${id}/object`;
    // The QR code is a link that opens the wallet and tells it where to fetch the request.
    const walletUrl = `${URLS.wallet}/#/present?request_uri=${encodeURIComponent(requestUri)}`;
    return c.json({ requestId: id, requestUri, walletUrl, expiresAt }, 201);
  });

  // Wallet: fetch what is being asked. "signedRequest" is the same content signed with the verifier's key;
  // the wallet trusts only that, after checking it against the chain registry.
  app.get('/v1/requests/:id/object', async (c) => {
    const request = getRequest(c.req.param('id'));
    if (!request) return c.json(refuse('unknown_request', 'No such request'), 404);
    const verifier = getVerifier(request.verifier_id)!;
    const content = {
      requestId: request.id,
      verifierId: verifier.id,
      purpose: verifier.purpose,
      claims: JSON.parse(request.claims_json) as string[],
      nonce: request.nonce,
      responseUri: `${URLS.verifierApi}/v1/requests/${request.id}/response`,
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
      return c.json(refuse('request_expired', 'This request has expired'), 410);
    }

    if (body.data.declined || !body.data.presentation) {
      finish(request.id, 'denied', { code: 'user_declined', message: 'The holder declined to share' });
      await recordAndShare('consent.denied', request.id);
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
    if (!result.ok) {
      outcome = { state: 'denied', result: { code: result.code, message: result.message } };
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
