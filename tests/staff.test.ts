// Issuer staff: PIN sign-in and permissions enforced by the server, the registry, and the audit log.
import { beforeEach, describe, expect, it } from 'vitest';
import { ISSUER_ID } from '@true/shared';
import { createHolderProof, createPresentation, generateHolderKey, generateSigningKeyPair, sha256Hex, type IssuerKeyInfo } from '@true/credentials';
import { openIssuerDb } from '../services/issuer-api/src/db.ts';
import { createIssuerApp, type IssuerChain } from '../services/issuer-api/src/app.ts';
import { openVerifierDb } from '../services/verifier-api/src/db.ts';
import { createVerifierApp } from '../services/verifier-api/src/app.ts';
import { refreshStatusList } from '../services/verifier-api/src/sync.ts';

// Test-only PINs. The demo's PINs live in .env, never in code.
const PINS = { admin: '1111', issuer: '2222', revoker: '3333', auditor: '4444' };
const STAFF = [
  { id: 'S-001', name: 'Test Admin', role: 'admin' as const, pin: PINS.admin },
  { id: 'S-002', name: 'Test Issuer', role: 'issuer' as const, pin: PINS.issuer },
  { id: 'S-003', name: 'Test Revoker', role: 'revoker' as const, pin: PINS.revoker },
  { id: 'S-004', name: 'Test Auditor', role: 'auditor' as const, pin: PINS.auditor },
];

let issuer: ReturnType<typeof createIssuerApp>;
let issuerDb: ReturnType<typeof openIssuerDb>;
let verifier: ReturnType<typeof createVerifierApp>;
let verifierDb: ReturnType<typeof openVerifierDb>;
let anchorHash = '';
let time: number;
const registry = new Map<string, IssuerKeyInfo>();

beforeEach(async () => {
  time = Date.now();
  registry.clear();
  const chain: IssuerChain = {
    addIssuerKey: async (keyId, publicJwk) => registry.set(keyId, { publicJwk, state: 'Active' }),
    setIssuerKeyState: async (keyId, state) => { registry.get(keyId)!.state = state; },
    anchorStatusList: async (hash) => { anchorHash = hash; },
  };
  const firstKey = await generateSigningKeyPair();
  registry.set('key-1', { publicJwk: firstKey.publicJwk, state: 'Active' });
  issuerDb = openIssuerDb(':memory:');
  // Staff sign-in is ON here (the default), unlike the other test files.
  issuer = createIssuerApp(issuerDb, firstKey, chain, { seedStaff: STAFF, now: () => time });
  verifierDb = openVerifierDb(':memory:');
  verifier = createVerifierApp(verifierDb, (id, keyId) => (id === ISSUER_ID ? registry.get(keyId) ?? null : null));
});

const json = (body: unknown, token?: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});
const auth = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

async function signIn(role: keyof typeof PINS): Promise<string> {
  const staff = STAFF.find((s) => s.role === role)!;
  const response = await issuer.request('/v1/staff/login', json({ staffId: staff.id, pin: staff.pin }));
  expect(response.status).toBe(200);
  return (await response.json()).token;
}

const nextYear = new Date(Date.now() + 300 * 86_400_000).toISOString().slice(0, 10);
const today = new Date().toISOString().slice(0, 10);
const issueBody = (studentId: number, type = 'StudentCredential') => ({ studentId, type, validFrom: today, validTill: nextYear });

// A holder collects the credential behind a claim code.
async function claim(code: string) {
  const holder = await generateHolderKey();
  const offer = await (await issuer.request(`/v1/claim-codes/${code}`)).json();
  const proof = await createHolderProof({ holderPrivateKey: holder.privateKey, holderPublicJwk: holder.publicJwk, nonce: offer.nonce, audience: ISSUER_ID });
  const { credential } = await (await issuer.request('/v1/credentials', json({ code, proof }))).json();
  return { holder, credential: credential as string };
}

async function present(holder: Awaited<ReturnType<typeof generateHolderKey>>, credential: string, verifierId = 'verifier:campus-store') {
  const { requestId } = await (await verifier.request('/v1/requests', json({ verifierId }))).json();
  const object = await (await verifier.request(`/v1/requests/${requestId}/object`)).json();
  const presentation = await createPresentation({ credential, holderPrivateKey: holder.privateKey, claims: object.claims, nonce: object.nonce, audience: object.verifierId });
  await verifier.request(`/v1/requests/${requestId}/response`, json({ presentation }));
  return (await verifier.request(`/v1/requests/${requestId}`)).json();
}

describe('sign-in', () => {
  it('nothing works without signing in', async () => {
    expect((await issuer.request('/v1/students')).status).toBe(401);
    expect((await issuer.request('/v1/claim-codes', json({ studentId: 1 }))).status).toBe(401);
    expect((await issuer.request('/v1/students/1/revoke', json({ reason: 'graduated' }))).status).toBe(401);
    expect((await issuer.request('/v1/keys/rotate', json({}))).status).toBe(401);
    expect((await issuer.request('/v1/students', auth('made-up-token'))).status).toBe(401);
  });

  it('PINs are stored only as salted hashes', () => {
    const rows = issuerDb.prepare('SELECT pin_hash FROM staff').all() as { pin_hash: string }[];
    for (const row of rows) {
      expect(row.pin_hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
      for (const pin of Object.values(PINS)) expect(row.pin_hash).not.toContain(pin);
    }
    expect(new Set(rows.map((r) => r.pin_hash.split(':')[0])).size).toBe(rows.length); // a different salt each
  });

  it('wrong PIN is refused and rate-limited: after 5 failures even the right PIN is locked out for a minute', async () => {
    const attempt = (pin: string) => issuer.request('/v1/staff/login', json({ staffId: 'S-002', pin }));
    for (let i = 0; i < 5; i++) expect((await attempt('0000')).status).toBe(401);
    const locked = await attempt(PINS.issuer);
    expect(locked.status).toBe(429);
    expect(locked.headers.get('Retry-After')).toBe('60');
    expect((await locked.json()).error.code).toBe('too_many_attempts');
    // Other staff are not affected, and the lock ends.
    await signIn('admin');
    time += 61_000;
    expect((await attempt(PINS.issuer)).status).toBe(200);
  });

  it('inactive staff are rejected: cannot sign in, and an open session stops working at once', async () => {
    const admin = await signIn('admin');
    const issuerToken = await signIn('issuer');
    expect((await issuer.request('/v1/students', auth(issuerToken))).status).toBe(200);
    expect((await issuer.request('/v1/staff/S-002/deactivate', json({}, admin))).status).toBe(200);

    const afterwards = await issuer.request('/v1/students', auth(issuerToken));
    expect(afterwards.status).toBe(403);
    expect((await afterwards.json()).error.code).toBe('staff_inactive');
    const login = await issuer.request('/v1/staff/login', json({ staffId: 'S-002', pin: PINS.issuer }));
    expect(login.status).toBe(403);
  });

  it('a session expires', async () => {
    const token = await signIn('auditor');
    time += 31 * 60_000;
    expect((await issuer.request('/v1/students', auth(token))).status).toBe(401);
  });
});

describe('permissions are enforced by the server', () => {
  it('auditor can read but cannot issue, revoke or touch keys', async () => {
    const token = await signIn('auditor');
    for (const path of ['/v1/students', '/v1/registry', '/v1/dashboard', '/v1/audit', '/v1/keys', '/v1/reports']) {
      expect((await issuer.request(path, auth(token))).status).toBe(200);
    }
    const revoke = await issuer.request('/v1/students/1/revoke', json({ reason: 'graduated' }, token));
    expect(revoke.status).toBe(403);
    expect((await revoke.json()).error.code).toBe('forbidden');
    expect((await issuer.request('/v1/issue', json(issueBody(1), token))).status).toBe(403);
    expect((await issuer.request('/v1/keys/rotate', json({}, token))).status).toBe(403);
    expect((await issuer.request('/v1/staff', auth(token))).status).toBe(403);
  });

  it('issuer can issue but cannot rotate keys, revoke or manage staff', async () => {
    const token = await signIn('issuer');
    expect((await issuer.request('/v1/issue', json(issueBody(1), token))).status).toBe(201);
    expect((await issuer.request('/v1/keys/rotate', json({}, token))).status).toBe(403);
    expect((await issuer.request('/v1/keys/key-1/compromise', json({}, token))).status).toBe(403);
    expect((await issuer.request('/v1/students/1/revoke', json({ reason: 'graduated' }, token))).status).toBe(403);
    expect((await issuer.request('/v1/staff', json({ name: 'Someone New', role: 'admin', pin: '9999' }, token))).status).toBe(403);
    expect(registry.get('key-1')!.state).toBe('Active');
  });

  it('revoker can revoke but cannot issue', async () => {
    const token = await signIn('revoker');
    expect((await issuer.request('/v1/issue', json(issueBody(1), token))).status).toBe(403);
    expect((await issuer.request('/v1/claim-codes', json({ studentId: 1 }, token))).status).toBe(403);
    expect((await issuer.request('/v1/students/1/revoke', json({ reason: 'graduated' }, token))).status).toBe(200);
  });

  it('admin manages keys and staff; a new staff member can sign in with their PIN', async () => {
    const admin = await signIn('admin');
    expect((await issuer.request('/v1/keys/rotate', json({}, admin))).status).toBe(200);
    const added = await issuer.request('/v1/staff', json({ name: 'New Revoker', role: 'revoker', pin: '5678' }, admin));
    expect(added.status).toBe(201);
    const { id } = await added.json();
    expect((await issuer.request('/v1/staff/login', json({ staffId: id, pin: '5678' }))).status).toBe(200);
    expect((await issuer.request('/v1/staff', json({ name: 'Bad Pin', role: 'issuer', pin: 'abc' }, admin))).status).toBe(400);
    expect((await issuer.request('/v1/staff/S-001/deactivate', json({}, admin))).status).toBe(409); // not yourself
  });
});

describe('issue, registry and revoke from the new console', () => {
  it('pending -> active -> revoked, and the holder\'s next verification fails with Revoked', async () => {
    const issuerToken = await signIn('issuer');
    const revokerToken = await signIn('revoker');
    const counts = async () => (await (await issuer.request('/v1/dashboard', auth(issuerToken))).json()).counts;

    const offer = await (await issuer.request('/v1/issue', json(issueBody(1), issuerToken))).json();
    expect(offer.credentialId).toBe('TR-SID-0001');
    expect(await counts()).toEqual({ issued: 0, active: 0, pending: 1, revoked: 0 });

    const { holder, credential } = await claim(offer.code);
    expect(await counts()).toEqual({ issued: 1, active: 1, pending: 0, revoked: 0 });
    expect((await present(holder, credential)).state).toBe('verified');

    // Revoke from the registry (reason code only), then the verifier's scheduled refresh picks it up.
    expect((await issuer.request(`/v1/registry/${offer.credentialId}/revoke`, json({ reason: 'free text is refused' }, revokerToken))).status).toBe(400);
    const revoke = await issuer.request(`/v1/registry/${offer.credentialId}/revoke`, json({ reason: 'lost' }, revokerToken));
    expect(revoke.status).toBe(200);
    const list = await (await issuer.request('/v1/status-list')).json();
    expect(await refreshStatusList(verifierDb, { fetchList: async () => list, getAnchorHash: async () => anchorHash, hash: sha256Hex })).toBe('updated');

    const after = await present(holder, credential);
    expect(after).toMatchObject({ state: 'denied', result: { code: 'revoked' } });
    expect(await counts()).toEqual({ issued: 1, active: 0, pending: 0, revoked: 1 });

    const detail = (await (await issuer.request(`/v1/registry/${offer.credentialId}`, auth(issuerToken))).json()).credential;
    expect(detail).toMatchObject({ display_status: 'revoked', revoked_reason: 'lost', issued_by: 'S-002', revoked_by: 'S-003', student_name: 'Aarav Deshmukh' });
    // The student is still eligible: a new credential can be issued and it verifies.
    const again = await (await issuer.request('/v1/issue', json(issueBody(1), issuerToken))).json();
    const fresh = await claim(again.code);
    expect((await present(fresh.holder, fresh.credential)).state).toBe('verified');
  });

  it('a Library Card is a separate credential with its own claims and its own revocation', async () => {
    const issuerToken = await signIn('issuer');
    const revokerToken = await signIn('revoker');
    const student = await claim((await (await issuer.request('/v1/issue', json(issueBody(2), issuerToken))).json()).code);
    const libraryOffer = await (await issuer.request('/v1/issue', json(issueBody(2, 'LibraryCard'), issuerToken))).json();
    expect(libraryOffer.credentialId).toBe('TR-LIB-0002');
    const library = await claim(libraryOffer.code);
    expect((await present(library.holder, library.credential, 'verifier:city-library')).state).toBe('verified');

    await issuer.request(`/v1/registry/${libraryOffer.credentialId}/revoke`, json({ reason: 'duplicate' }, revokerToken));
    const list = await (await issuer.request('/v1/status-list')).json();
    await refreshStatusList(verifierDb, { fetchList: async () => list, getAnchorHash: async () => anchorHash, hash: sha256Hex });
    expect((await present(library.holder, library.credential, 'verifier:city-library')).result.code).toBe('revoked');
    expect((await present(student.holder, student.credential)).state).toBe('verified'); // the Student ID is untouched
  });

  it('registry filters, search and an expired offer', async () => {
    let token = await signIn('issuer');
    const first = await (await issuer.request('/v1/issue', json(issueBody(1), token))).json();
    await claim(first.code);
    await issuer.request('/v1/issue', json(issueBody(3), token));
    const list = async (status: string) => (await (await issuer.request(`/v1/registry?status=${status}`, auth(token))).json()).credentials.length;
    expect([await list('active'), await list('pending'), await list('revoked')]).toEqual([1, 1, 0]);
    time += 11 * 60_000; // the QR / claim code runs out, but the offer itself stays open for a day
    expect([await list('pending'), await list('expired')]).toEqual([1, 0]);
    time += 24 * 3_600_000;
    token = await signIn('issuer'); // the 30-minute session ended long ago
    expect([await list('pending'), await list('expired')]).toEqual([0, 1]);

    const search = async (q: string) => (await (await issuer.request(`/v1/students?q=${encodeURIComponent(q)}`, auth(await signIn('auditor')))).json()).students.map((s: { name: string }) => s.name);
    expect(await search('isha')).toEqual(['Isha Kulkarni']);
    expect(await search('AIT2024003')).toEqual(['Rohan Patil']);
    expect(await search('7')).toContain('Dev Mehta');
    expect((await issuer.request('/v1/issue', json({ ...issueBody(1), validTill: '2001-01-01' }, token))).status).toBe(400);
  });

  it('the audit log records the staff id for every action and contains no names', async () => {
    const issuerToken = await signIn('issuer');
    const revokerToken = await signIn('revoker');
    const adminToken = await signIn('admin');
    const offer = await (await issuer.request('/v1/issue', json(issueBody(1), issuerToken))).json();
    await claim(offer.code);
    await issuer.request(`/v1/registry/${offer.credentialId}/revoke`, json({ reason: 'violation' }, revokerToken));
    await issuer.request('/v1/keys/rotate', json({}, adminToken));

    const events = (await (await issuer.request('/v1/audit', auth(adminToken))).json()).events as { type: string; staff_id: string | null; subject: string }[];
    const find = (type: string) => events.find((e) => e.type === type)!;
    expect(find('credential.offered')).toMatchObject({ staff_id: 'S-002', subject: 'TR-SID-0001' });
    expect(find('credential.claimed')).toMatchObject({ staff_id: null, subject: 'TR-SID-0001' });
    expect(find('credential.revoked')).toMatchObject({ staff_id: 'S-003', subject: 'TR-SID-0001' });
    expect(find('key.rotated')).toMatchObject({ staff_id: 'S-001', subject: 'key-2' });
    // Whole table: identifiers only.
    const everything = JSON.stringify(issuerDb.prepare('SELECT * FROM audit_events').all());
    for (const personal of ['Aarav', 'AIT2023001', 'Lake View', '2005-03-14', 'Test Issuer']) expect(everything).not.toContain(personal);

    const revokesOnly = (await (await issuer.request('/v1/audit?kind=revoke', auth(adminToken))).json()).events;
    expect(revokesOnly.every((e: { type: string }) => e.type.includes('revoked'))).toBe(true);
  });

  it('reports are computed from the registry', async () => {
    const token = await signIn('issuer');
    await claim((await (await issuer.request('/v1/issue', json(issueBody(1), token))).json()).code);
    await claim((await (await issuer.request('/v1/issue', json(issueBody(1, 'LibraryCard'), token))).json()).code);
    const report = await (await issuer.request('/v1/reports', auth(token))).json();
    expect(report.counts).toMatchObject({ issued: 2, offered: 2, revoked: 0, active: 2, pending: 0 });
    expect(report.trend).toHaveLength(30);
    expect(report.trend.at(-1).issued).toBe(2);
    expect(report.trend.slice(0, -1).every((point: { issued: number }) => point.issued === 0)).toBe(true);
    expect(report.byType).toEqual([{ type: 'StudentCredential', count: 1 }, { type: 'LibraryCard', count: 1 }]);
  });
});
