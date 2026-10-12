// Offers inbox: an offer made by staff reaches the holder's app after the holder links their record.
import { beforeEach, describe, expect, it } from 'vitest';
import { generateSigningKeyPair, readCredential } from '@true/credentials';
import {
  acceptInboxOffer, declineInboxOffer, getCredentials, getInboxLink, getInboxOffers, linkInstituteRecord, resetWallet,
  useMemoryStorage, type Fetch,
} from '@true/wallet-core';
import { openIssuerDb } from '../services/issuer-api/src/db.ts';
import { createIssuerApp } from '../services/issuer-api/src/app.ts';

const ISSUER_API = 'http://localhost:4001';
const STAFF = [
  { id: 'S-002', name: 'Test Issuer', role: 'issuer' as const, pin: '2222' },
  { id: 'S-003', name: 'Test Revoker', role: 'revoker' as const, pin: '3333' },
];
// Fake students from the seed: Kabir (id 5) and Isha (id 2).
const KABIR = { id: 5, pnr: 'AIT2023005', dob: '2005-09-09' };
const ISHA = { id: 2, pnr: 'AIT2023002', dob: '2004-11-02' };

let issuer: ReturnType<typeof createIssuerApp>;
let issuerDb: ReturnType<typeof openIssuerDb>;
let time: number;
let source = 'phone-1'; // stands in for the caller's IP address
let fetchStub: Fetch;

const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const signIn = async (staffId: string, pin: string) => (await (await issuer.request('/v1/staff/login', json({ staffId, pin }))).json()).token as string;
const env = () => ({ issuerApi: ISSUER_API, fetch: fetchStub });
const link = (who: { pnr: string; dob: string }) => issuer.request('/v1/inbox/link', json({ pnr: who.pnr, dob: who.dob }, { 'x-test-source': source }));

const today = new Date().toISOString().slice(0, 10);
const nextYear = new Date(Date.now() + 300 * 86_400_000).toISOString().slice(0, 10);
async function offerTo(studentId: number, type = 'LibraryCard') {
  const token = await signIn('S-002', '2222');
  return (await (await issuer.request('/v1/issue', json({ studentId, type, validFrom: today, validTill: nextYear }, bearer(token)))).json()) as { credentialId: string; code: string };
}
const registryStatus = async (id: string) => {
  const token = await signIn('S-003', '3333');
  return (await (await issuer.request(`/v1/registry/${id}`, { headers: bearer(token) })).json()).credential.display_status as string;
};

beforeEach(async () => {
  useMemoryStorage();
  await resetWallet();
  time = Date.now();
  source = 'phone-1';
  issuerDb = openIssuerDb(':memory:');
  issuer = createIssuerApp(issuerDb, await generateSigningKeyPair(), undefined, {
    seedStaff: STAFF, now: () => time, getSource: (c) => c.req.header('x-test-source') ?? 'unknown',
  });
  fetchStub = async (url, init) => issuer.request(new URL(url).pathname, { ...init, headers: { ...init?.headers, 'x-test-source': source } });
});

describe('linking the institute record', () => {
  it('wrong date of birth, wrong PNR and rubbish all get the same generic error', async () => {
    const wrongDate = await link({ pnr: KABIR.pnr, dob: '2000-01-01' });
    const wrongPnr = await link({ pnr: 'NOSUCH123', dob: KABIR.dob });
    const rubbish = await issuer.request('/v1/inbox/link', json({ hello: 1 }, { 'x-test-source': source }));
    const bodies = await Promise.all([wrongDate, wrongPnr, rubbish].map((r) => r.json()));
    expect([wrongDate.status, wrongPnr.status, rubbish.status]).toEqual([401, 401, 401]);
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1); // byte-for-byte identical
    expect(bodies[0].error).toEqual({ code: 'link_failed', message: 'Those details do not match our records' });
  });

  it('failures are rate-limited per source: 5 a minute, then even the right details are locked out', async () => {
    for (let i = 0; i < 5; i++) expect((await link({ pnr: KABIR.pnr, dob: '2000-01-01' })).status).toBe(401);
    const locked = await link(KABIR);
    expect(locked.status).toBe(429);
    expect(locked.headers.get('Retry-After')).toBe('60');
    source = 'phone-2'; // someone else is not affected
    expect((await link(KABIR)).status).toBe(200);
    source = 'phone-1';
    time += 61_000;
    expect((await link(KABIR)).status).toBe(200);
  });

  it('failed attempts are logged without the PNR or the date, and the typed date is never stored', async () => {
    await link({ pnr: KABIR.pnr, dob: '2000-01-01' });
    await linkInstituteRecord({ ...KABIR, ...env() });
    const everything = JSON.stringify([
      issuerDb.prepare('SELECT * FROM audit_events').all(),
      issuerDb.prepare('SELECT * FROM inbox_tokens').all(),
      await getInboxLink(),
    ]);
    expect(everything).toContain('inbox.link_failed');
    expect(everything).not.toContain('2000-01-01');
    expect(everything).not.toContain(KABIR.dob);
    const failed = issuerDb.prepare("SELECT subject FROM audit_events WHERE type = 'inbox.link_failed'").get() as { subject: string };
    expect(failed.subject).toMatch(/^source:[0-9a-f]{16}$/);
    // The token itself is not in the database, only its hash.
    expect(JSON.stringify(issuerDb.prepare('SELECT * FROM inbox_tokens').all())).not.toContain((await getInboxLink())!.token);
  });
});

describe('offers in the holder app', () => {
  it('an offer made by staff appears; Accept puts a card in the wallet and the registry row becomes Active', async () => {
    const offer = await offerTo(KABIR.id);
    expect((await getInboxOffers(env())).offers).toEqual([]); // not linked yet: nothing
    await linkInstituteRecord({ ...KABIR, ...env() });
    const { offers } = await getInboxOffers(env());
    expect(offers).toMatchObject([{ id: offer.credentialId, type: 'LibraryCard' }]);
    expect(await registryStatus(offer.credentialId)).toBe('pending');

    await acceptInboxOffer({ offerId: offer.credentialId, ...env() });
    const cards = await getCredentials();
    expect(cards).toHaveLength(1);
    expect(await readCredential(cards[0].credential)).toMatchObject({ name: 'Kabir Shaikh', vct: 'LibraryCard', library_member: true });
    expect(await registryStatus(offer.credentialId)).toBe('active');
    expect((await getInboxOffers(env())).offers).toEqual([]); // collected, so no longer offered
  });

  it('Accept still works after the 10-minute QR code has run out (within the 24-hour offer window)', async () => {
    const offer = await offerTo(KABIR.id);
    await linkInstituteRecord({ ...KABIR, ...env() });
    time += 30 * 60_000;
    expect((await issuer.request(`/v1/claim-codes/${offer.code}`)).status).toBe(400); // the QR / code path has expired
    await acceptInboxOffer({ offerId: offer.credentialId, ...env() });
    expect(await getCredentials()).toHaveLength(1);
  });

  it("one student's token cannot see, accept or decline another student's offers", async () => {
    const kabirOffer = await offerTo(KABIR.id);
    await offerTo(ISHA.id, 'StudentCredential');
    await linkInstituteRecord({ ...ISHA, ...env() }); // this phone is Isha's
    const { offers } = await getInboxOffers(env());
    expect(offers).toHaveLength(1);
    expect(offers[0].id).not.toBe(kabirOffer.credentialId);

    await expect(acceptInboxOffer({ offerId: kabirOffer.credentialId, ...env() })).rejects.toThrow('No such open offer');
    await expect(declineInboxOffer({ offerId: kabirOffer.credentialId, ...env() })).rejects.toThrow('No such open offer');
    expect(await getCredentials()).toHaveLength(0);
    expect(await registryStatus(kabirOffer.credentialId)).toBe('pending'); // untouched
  });

  it('Decline marks the offer declined, the issuer sees it, and its claim code stops working', async () => {
    const offer = await offerTo(KABIR.id);
    await linkInstituteRecord({ ...KABIR, ...env() });
    await declineInboxOffer({ offerId: offer.credentialId, ...env() });
    expect(await registryStatus(offer.credentialId)).toBe('declined');
    expect((await getInboxOffers(env())).offers).toEqual([]);
    const types = (issuerDb.prepare('SELECT type, staff_id, subject FROM audit_events').all() as { type: string; staff_id: string | null; subject: string }[]);
    expect(types.find((e) => e.type === 'offer.declined')).toMatchObject({ staff_id: null, subject: offer.credentialId });
    expect((await issuer.request('/v1/credentials', json({ code: offer.code, proof: 'x' }))).status).toBe(409);
  });

  it('Cancel offer: issuer role only, logged with the staff id, and the offer disappears for the holder', async () => {
    const offer = await offerTo(KABIR.id);
    await linkInstituteRecord({ ...KABIR, ...env() });
    const revoker = await signIn('S-003', '3333');
    expect((await issuer.request(`/v1/registry/${offer.credentialId}/cancel`, json({}, bearer(revoker)))).status).toBe(403);
    expect((await issuer.request(`/v1/registry/${offer.credentialId}/cancel`, json({}))).status).toBe(401);

    const issuerToken = await signIn('S-002', '2222');
    expect((await issuer.request(`/v1/registry/${offer.credentialId}/cancel`, json({}, bearer(issuerToken)))).status).toBe(200);
    expect(await registryStatus(offer.credentialId)).toBe('cancelled');
    expect((await getInboxOffers(env())).offers).toEqual([]);
    await expect(acceptInboxOffer({ offerId: offer.credentialId, ...env() })).rejects.toThrow('No such open offer');
    const event = issuerDb.prepare("SELECT staff_id, subject FROM audit_events WHERE type = 'offer.cancelled'").get();
    expect(event).toMatchObject({ staff_id: 'S-002', subject: offer.credentialId });
    expect((await issuer.request(`/v1/registry/${offer.credentialId}/cancel`, json({}, bearer(issuerToken)))).status).toBe(409); // already cancelled
  });

  it('an expired or made-up inbox token is rejected, and the app forgets the link', async () => {
    const offer = await offerTo(KABIR.id);
    await linkInstituteRecord({ ...KABIR, ...env() });
    const token = (await getInboxLink())!.token;
    expect((await issuer.request('/v1/inbox/offers', { headers: bearer(token) })).status).toBe(200);
    expect((await issuer.request('/v1/inbox/offers', { headers: bearer('made-up') })).status).toBe(401);
    expect((await issuer.request('/v1/inbox/offers')).status).toBe(401);

    time += 24 * 3_600_000 + 1000;
    expect((await issuer.request('/v1/inbox/offers', { headers: bearer(token) })).status).toBe(401);
    expect((await issuer.request(`/v1/inbox/offers/${offer.credentialId}/accept`, { method: 'POST', headers: bearer(token) })).status).toBe(401);
    expect(await getInboxOffers(env())).toEqual({ link: undefined, offers: [] });
    expect(await getInboxLink()).toBeUndefined();
  });

  it('the QR / claim code path still works without any linking', async () => {
    const offer = await offerTo(KABIR.id, 'StudentCredential');
    const { claimCredential } = await import('@true/wallet-core');
    await claimCredential({ code: offer.code, ...env() });
    expect(await getCredentials()).toHaveLength(1);
    expect(await registryStatus(offer.credentialId)).toBe('active');
  });
});
