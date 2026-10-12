// Verifier API routes.
// Hard rule: nothing in this file calls the issuer's API or database. A presentation is checked using
// only its own signatures and the issuer's public key from the registry.
import { Hono, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { URLS } from '@true/shared';
import { verifyPresentation, randomToken, type Jwk } from '@true/credentials';
import type { VerifierRow, RequestRow } from './db.ts';
import {
  addAuditEvent, exportState, getStatusBits, isRevoked, mergeState, setRevoked, toShared, type SharedState,
} from './sync.ts';

const REQUEST_MINUTES = 5;

// Looks up a trusted issuer's public key. M1: a local registry file. M2: the chain.
export type IssuerKeyLookup = (issuerId: string) => Promise<Jwk | null> | Jwk | null;

const refuse = (code: string, message: string) => ({ error: { code, message } });

// Settings for running two instances that share state. All optional, so a single instance still works.
export type InstanceOptions = {
  instance?: string; // name shown in the status panel, e.g. "1"
  internalKey?: string; // secret both instances know; protects /internal/*
  sendToPeer?: (state: SharedState) => Promise<unknown>; // delivers changes to the other instances
  apiKey?: string; // partner API key (X-API-Key). If not set, the check is off (tests, first run)
  allowedOrigins?: string[]; // browser origins allowed by CORS. If not set, any origin
  syncedAtStart?: boolean; // true if this instance pulled the full state from a peer when it started
};

export function createVerifierApp(db: DatabaseSync, getIssuerPublicJwk: IssuerKeyLookup, options: InstanceOptions = {}) {
  const app = new Hono();
  // CORS: which web pages may call this API from a browser. Our own apps plus the partner's origin.
  app.use('*', cors({ origin: options.allowedOrigins ?? '*', allowHeaders: ['content-type', 'x-api-key'], exposeHeaders: ['X-Served-By'] }));

  // Partner endpoints need the API key in the X-API-Key header.
  // The two wallet endpoints (/object and /response) do not: a wallet has no partner key,
  // and it can only reach a request if it was given that request's unguessable id.
  const requireApiKey: MiddlewareHandler = async (c, next) => {
    if (options.apiKey && c.req.header('x-api-key') !== options.apiKey) {
      return c.json(refuse('invalid_api_key', 'Missing or wrong X-API-Key header'), 401);
    }
    await next();
  };
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
    const event = { id: randomToken(), ts: new Date().toISOString(), type, request_id: requestId, instance };
    addAuditEvent(db, event);
    await share({ requests: [toShared(getRequest(requestId)!)], auditEvents: [event] });
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

  app.get('/health', (c) => c.json({ instance, alive: true, lastSyncedAt }));

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

  app.get('/v1/audit/events', requireApiKey, (c) => c.json({ events: db.prepare('SELECT * FROM audit_events ORDER BY ts').all() }));

  // The verifier screen lists who it can act as (three demo verifiers).
  app.get('/v1/verifiers', requireApiKey, (c) => {
    const rows = db.prepare('SELECT * FROM verifiers ORDER BY name').all() as VerifierRow[];
    return c.json({
      verifiers: rows.map((v) => ({ id: v.id, name: v.name, purpose: v.purpose, claims: JSON.parse(v.allowed_claims_json) })),
    });
  });

  // Create a presentation request: which claims, plus a fresh one-time nonce.
  app.post('/v1/requests', requireApiKey, async (c) => {
    const body = z.object({ verifierId: z.string() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(refuse('bad_request', 'verifierId is required'), 400);
    const verifier = getVerifier(body.data.verifierId);
    if (!verifier) return c.json(refuse('unknown_verifier', 'No such verifier'), 404);

    const id = randomToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + REQUEST_MINUTES * 60_000).toISOString();
    db.prepare('INSERT INTO requests (id, verifier_id, claims_json, nonce, created_at, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id, verifier.id, verifier.allowed_claims_json, randomToken(), now.toISOString(), expiresAt, now.toISOString(),
    );
    await recordAndShare('request.created', id);
    const requestUri = `${URLS.verifierApi}/v1/requests/${id}/object`;
    // The QR code is a link that opens the wallet and tells it where to fetch the request.
    const walletUrl = `${URLS.wallet}/#/present?request_uri=${encodeURIComponent(requestUri)}`;
    return c.json({ requestId: id, requestUri, walletUrl, expiresAt }, 201);
  });

  // Wallet: fetch what is being asked. (M3 turns this into a signed JWT so the wallet can authenticate the verifier.)
  app.get('/v1/requests/:id/object', (c) => {
    const request = getRequest(c.req.param('id'));
    if (!request) return c.json(refuse('unknown_request', 'No such request'), 404);
    const verifier = getVerifier(request.verifier_id)!;
    return c.json({
      requestId: request.id,
      verifierId: verifier.id,
      verifierName: verifier.name,
      purpose: verifier.purpose,
      claims: JSON.parse(request.claims_json),
      nonce: request.nonce,
      responseUri: `${URLS.verifierApi}/v1/requests/${request.id}/response`,
      expiresAt: request.expires_at,
    });
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
      getIssuerPublicJwk,
    });

    // Policy check: every claim we asked for must actually have been disclosed.
    const wanted = JSON.parse(request.claims_json) as string[];
    let outcome: { state: 'verified' | 'denied'; result: object };
    if (!result.ok) {
      outcome = { state: 'denied', result: { code: result.code, message: result.message } };
    } else if (wanted.some((claim) => !(claim in result.claims))) {
      outcome = { state: 'denied', result: { code: 'missing_claims', message: 'A requested claim was not disclosed' } };
    } else if (wanted.some((claim) => result.claims[claim] === false)) {
      // A genuine credential that honestly answers "No" (e.g. age_over_18: false) proves the person does NOT qualify.
      outcome = { state: 'denied', result: { code: 'requirement_not_met', message: 'The credential is genuine but answers No' } };
    } else {
      outcome = { state: 'verified', result: { issuer: result.issuer, claims: result.claims } };
    }

    if (!finish(request.id, outcome.state, outcome.result)) {
      return c.json(refuse('request_already_answered', 'This request was already answered'), 409);
    }
    await recordAndShare(outcome.state === 'verified' ? 'presentation.verified' : 'presentation.failed', request.id);
    return c.json({ state: outcome.state, ...outcome.result });
  });

  // Verifier screen polls this once a second to update live.
  app.get('/v1/requests/:id', requireApiKey, (c) => {
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

  // Stateless check for partner back ends (Convergence Round): they supply their own nonce and audience.
  app.post('/v1/verify', requireApiKey, async (c) => {
    const body = z
      .object({ presentation: z.string(), nonce: z.string(), audience: z.string() })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(refuse('bad_request', 'presentation, nonce and audience are required'), 400);
    return c.json(await verifyPresentation({ ...body.data, getIssuerPublicJwk }));
  });

  return app;
}
