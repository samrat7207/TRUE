// Accounts, institutions and offers: who can see and do what.
import { beforeEach, describe, expect, it } from 'vitest';
import { decodeProtectedHeader } from 'jose';
import { readCredential } from '@true/credentials';
import { acceptOffer, getCredentials, getOffers, rejectOffer, setWalletOwner } from '@true/wallet-core';
import { verifyInstitution } from '../services/issuer-api/src/app.ts';
import { FIELDS, PASSWORD, auth, json, world } from './helpers.ts';

let w: Awaited<ReturnType<typeof world>>;
beforeEach(async () => { w = await world(); });

const signup = (body: object) => w.core.request('/v1/auth/signup', json(body));

describe('sign up and log in', () => {
  it('a person and an institution can sign up; passwords are stored only as salted hashes', async () => {
    const person = await signup({ kind: 'person', name: 'Meera Joshi', email: 'Meera@Test.True', password: 'a-long-password' });
    expect(person.status).toBe(201);
    const body = await person.json();
    expect(body.account).toMatchObject({ kind: 'person', name: 'Meera Joshi', email: 'meera@test.true' });
    expect((await w.login('meera@test.true', 'a-long-password')).status).toBe(200);

    const rows = w.coreDb.prepare('SELECT password_hash FROM accounts').all() as { password_hash: string }[];
    for (const row of rows) expect(row.password_hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
    expect(new Set(rows.map((r) => r.password_hash.split(':')[0])).size).toBe(rows.length); // a different salt each
    expect(JSON.stringify(w.coreDb.prepare('SELECT * FROM accounts').all())).not.toContain('a-long-password');
  });

  it('refuses a duplicate email, a short password and a bad email', async () => {
    expect((await signup({ kind: 'person', name: 'Copy', email: 'aarav@test.true', password: 'another-password' })).status).toBe(409);
    expect((await signup({ kind: 'person', name: 'Short', email: 'short@test.true', password: 'abc' })).status).toBe(400);
    expect((await signup({ kind: 'person', name: 'Bad', email: 'not-an-email', password: 'another-password' })).status).toBe(400);
  });

  it('wrong password and unknown email give the same message, are rate-limited, and are never logged', async () => {
    const wrong = await w.login('aarav@test.true', 'wrong-password');
    const unknown = await w.login('nobody@test.true', 'wrong-password');
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(wrong.body).toEqual(unknown.body);

    for (let i = 0; i < 4; i++) await w.login('aarav@test.true', 'wrong-password');
    const locked = await w.login('aarav@test.true'); // the right password, but locked out
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('too_many_attempts');
    expect((await w.login('isha@test.true')).status).toBe(200); // other accounts are not affected
    w.advance(61);
    expect((await w.login('aarav@test.true')).status).toBe(200);

    const log = JSON.stringify(w.coreDb.prepare('SELECT * FROM audit_events').all());
    for (const secret of ['wrong-password', PASSWORD, 'aarav@test.true', 'nobody@test.true']) expect(log).not.toContain(secret);
  });

  it('a session token is needed, and one kind of account cannot use the other kind\'s routes', async () => {
    expect((await w.core.request('/v1/me/offers')).status).toBe(401);
    expect((await w.core.request('/v1/institution/dashboard', auth('made-up'))).status).toBe(401);
    const person = await w.login('aarav@test.true');
    const institution = await w.login('astra@test.true');
    expect((await w.core.request('/v1/institution/dashboard', auth(person.token))).status).toBe(403);
    expect((await w.core.request('/v1/me/offers', auth(institution.token))).status).toBe(403);
    expect((await (await w.core.request('/v1/auth/me', auth(person.token))).json()).account.name).toBe('Aarav Deshmukh');
  });
});

describe('issuing by email', () => {
  it('an unknown email gets "No TRUE user with this email", and the check is limited to 5 a minute per institution', async () => {
    const astra = await w.login('astra@test.true');
    const lookup = (email: string, token = astra.token) => w.core.request('/v1/institution/lookup', json({ email }, token));
    const missing = await lookup('nobody@test.true');
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.message).toBe('No TRUE user with this email');
    expect((await lookup('aarav@test.true')).status).toBe(200);
    expect((await lookup('astra@test.true')).status).toBe(404); // an institution account is not a TRUE user to issue to

    for (let i = 0; i < 2; i++) await lookup('nobody@test.true'); // that makes 5 checks
    const limited = await lookup('aarav@test.true');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).not.toBeNull();
    // Issuing counts as a check too, so it cannot be used to get around the limit.
    expect((await w.offer(astra.token, 'aarav@test.true')).response.status).toBe(429);
    const gym = await w.login('gym@test.true');
    expect((await lookup('aarav@test.true', gym.token)).status).toBe(200); // another institution has its own allowance
    w.advance(61);
    expect((await lookup('aarav@test.true')).status).toBe(200);

    // The checks are logged without the email that was typed.
    expect(JSON.stringify(w.coreDb.prepare('SELECT * FROM audit_events').all())).not.toContain('nobody@test.true');
  });

  it('the template decides the fields: missing or extra fields are refused', async () => {
    const astra = await w.login('astra@test.true');
    const { name, ...missingName } = FIELDS.LibraryCard;
    expect((await w.offer(astra.token, 'aarav@test.true', 'LibraryCard', missingName)).response.status).toBe(400);
    expect((await w.offer(astra.token, 'aarav@test.true', 'LibraryCard', { ...FIELDS.LibraryCard, salary: '1' })).response.status).toBe(400);
    expect((await w.core.request('/v1/institution/offers', json({ email: 'aarav@test.true', template: 'Passport', fields: {} }, astra.token))).status).toBe(400);
    expect((await w.offer(astra.token, 'aarav@test.true', 'LibraryCard')).response.status).toBe(201);
  });

  it('an institution can never list, browse or search people', async () => {
    const astra = await w.login('astra@test.true');
    for (const path of ['/v1/accounts', '/v1/people', '/v1/users', '/v1/institution/people', '/v1/institution/search?q=a', '/v1/students']) {
      expect((await w.core.request(path, auth(astra.token))).status).toBe(404);
    }
    // Its own credential list shows what it typed in, and no account details (no email, no account id).
    await w.issueTo('aarav@test.true');
    const list = JSON.stringify(await (await w.core.request('/v1/institution/credentials', auth(astra.token))).json());
    expect(list).not.toContain('aarav@test.true');
    expect(list).not.toContain('person:');
  });
});

describe('offers', () => {
  it('accept: the card lands in the wallet, signed by that institution\'s own key, and the counts move', async () => {
    const astra = await w.login('astra@test.true');
    const aarav = await w.login('aarav@test.true');
    const counts = async () => (await (await w.core.request('/v1/institution/dashboard', auth(astra.token))).json()).counts;
    const { id } = await w.offer(astra.token, 'aarav@test.true');
    expect(await counts()).toMatchObject({ issued: 0, active: 0, pending: 1, revoked: 0 });

    const offers = await getOffers(w.apiFor(aarav.token));
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ id, template: 'StudentID', institution: { name: 'Astra Institute of Technology', verified: true } });

    setWalletOwner(aarav.id);
    const card = await acceptOffer(w.apiFor(aarav.token), id);
    expect(await getCredentials()).toHaveLength(1);
    expect(await counts()).toMatchObject({ issued: 1, active: 1, pending: 0 });
    expect(await getOffers(w.apiFor(aarav.token))).toHaveLength(0);

    const claims = await readCredential(card.credential);
    expect(claims).toMatchObject({ ...FIELDS.StudentID, iss: astra.id, vct: 'StudentID' });
    expect(decodeProtectedHeader(card.credential.split('~')[0]).kid).toBe('key-1');
    expect(w.getIssuerKey(astra.id, 'key-1')).not.toBeNull(); // that institution's key is in the registry
    // Accepting twice is not possible.
    await expect(acceptOffer(w.apiFor(aarav.token), id)).rejects.toThrow('No such open offer');
  });

  it('reject: nothing is issued and the institution sees Declined', async () => {
    const astra = await w.login('astra@test.true');
    const aarav = await w.login('aarav@test.true');
    const { id } = await w.offer(astra.token, 'aarav@test.true');
    await rejectOffer(w.apiFor(aarav.token), id);
    setWalletOwner(aarav.id);
    expect(await getCredentials()).toHaveLength(0);
    const detail = await (await w.core.request(`/v1/institution/credentials/${id}`, auth(astra.token))).json();
    expect(detail.credential.status).toBe('declined');
    await expect(acceptOffer(w.apiFor(aarav.token), id)).rejects.toThrow('No such open offer');
  });

  it('a person cannot see, accept or reject another person\'s offers', async () => {
    const astra = await w.login('astra@test.true');
    const isha = await w.login('isha@test.true');
    const { id } = await w.offer(astra.token, 'aarav@test.true');
    expect(await getOffers(w.apiFor(isha.token))).toEqual([]);
    setWalletOwner(isha.id);
    await expect(acceptOffer(w.apiFor(isha.token), id)).rejects.toThrow('No such open offer');
    await expect(rejectOffer(w.apiFor(isha.token), id)).rejects.toThrow('No such open offer');
    expect(await getCredentials()).toHaveLength(0);
  });

  it('an institution cannot see or touch another institution\'s credentials', async () => {
    const { id } = await w.issueTo('aarav@test.true', 'astra@test.true');
    const pending = await w.offer((await w.login('astra@test.true')).token, 'isha@test.true');
    const gym = await w.login('gym@test.true');
    expect((await (await w.core.request('/v1/institution/credentials', auth(gym.token))).json()).credentials).toEqual([]);
    expect((await (await w.core.request('/v1/institution/dashboard', auth(gym.token))).json()).counts).toMatchObject({ issued: 0, active: 0, pending: 0 });
    expect((await w.core.request(`/v1/institution/credentials/${id}`, auth(gym.token))).status).toBe(404);
    expect((await w.core.request(`/v1/institution/credentials/${id}/revoke`, json({ reason: 'other' }, gym.token))).status).toBe(404);
    expect((await w.core.request(`/v1/institution/credentials/${pending.id}/cancel`, json({}, gym.token))).status).toBe(404);
    expect((await (await w.core.request('/v1/institution/activity', auth(gym.token))).json()).events.every((e: { subject: string }) => e.subject !== id)).toBe(true);
  });

  it('cancel withdraws a pending offer', async () => {
    const astra = await w.login('astra@test.true');
    const aarav = await w.login('aarav@test.true');
    const { id } = await w.offer(astra.token, 'aarav@test.true');
    expect((await w.core.request(`/v1/institution/credentials/${id}/cancel`, json({}, astra.token))).status).toBe(200);
    expect(await getOffers(w.apiFor(aarav.token))).toEqual([]);
    expect((await w.core.request(`/v1/institution/credentials/${id}/cancel`, json({}, astra.token))).status).toBe(409);
  });

  it('an unverified institution is labelled as such until the operator verifies it', async () => {
    const created = await (await signup({ kind: 'institution', name: 'Pop-up College', email: 'popup@test.true', password: 'a-long-password', category: 'college' })).json();
    expect(created.account.verified).toBe(false);
    expect(w.chainState.verified.get(created.account.id) ?? false).toBe(false); // the registry says unverified too
    const aarav = await w.login('aarav@test.true');
    await w.offer(created.token, 'aarav@test.true', 'LibraryCard');
    expect((await getOffers(w.apiFor(aarav.token)))[0].institution).toMatchObject({ name: 'Pop-up College', verified: false });

    // npm run verify-institution -- popup@test.true
    expect(await verifyInstitution(w.coreDb, 'nobody@test.true', async () => {})).toBeNull();
    expect(await verifyInstitution(w.coreDb, 'popup@test.true', async (id) => w.chainState.verified.set(id, true))).toBe(created.account.id);
    expect(w.chainState.verified.get(created.account.id)).toBe(true);
    expect((await getOffers(w.apiFor(aarav.token)))[0].institution.verified).toBe(true);
  });
});

describe('revoking and deleting', () => {
  it('revoke makes the holder\'s next verification fail with Revoked', async () => {
    const { id, card, institution } = await w.issueTo('aarav@test.true');
    expect((await w.present(card)).state).toBe('verified');
    expect((await w.core.request(`/v1/institution/credentials/${id}/revoke`, json({ reason: 'free text' }, institution.token))).status).toBe(400);
    expect((await w.core.request(`/v1/institution/credentials/${id}/revoke`, json({ reason: 'lost' }, institution.token))).status).toBe(200);
    expect(await w.refreshRevocations()).toBe('updated');
    expect(await w.present(card)).toMatchObject({ state: 'denied', code: 'revoked' });
  });

  it('deleting a person revokes every credential they hold (holder_deleted) and ends their session', async () => {
    const { id, card, person, institution } = await w.issueTo('aarav@test.true');
    const pending = await w.offer(institution.token, 'aarav@test.true', 'LibraryCard');
    expect((await w.core.request('/v1/auth/delete', json({ password: 'wrong' }, person.token))).status).toBe(401);
    expect((await w.core.request('/v1/auth/delete', json({ password: PASSWORD }, person.token))).status).toBe(200);

    const seen = async (credentialId: string) => (await (await w.core.request(`/v1/institution/credentials/${credentialId}`, auth(institution.token))).json()).credential;
    expect(await seen(id)).toMatchObject({ status: 'revoked', revokedReason: 'holder_deleted' });
    expect((await seen(pending.id)).status).toBe('cancelled');
    await w.refreshRevocations();
    expect(await w.present(card)).toMatchObject({ state: 'denied', code: 'revoked' });
    expect((await w.core.request('/v1/auth/me', auth(person.token))).status).toBe(401); // the old token is dead
    expect((await w.login('aarav@test.true')).status).toBe(401);
    expect((await w.core.request('/v1/institution/lookup', json({ email: 'aarav@test.true' }, institution.token))).status).toBe(404);
  });

  it('deleting an institution retires its key and revokes everything it issued', async () => {
    const { card, institution } = await w.issueTo('aarav@test.true');
    expect((await w.core.request('/v1/auth/delete', json({ password: PASSWORD }, institution.token))).status).toBe(200);
    expect(w.getIssuerKey(institution.id, 'key-1')!.state).toBe('Retired');
    expect(w.chainState.verified.get(institution.id)).toBe(false);
    await w.refreshRevocations();
    expect(await w.present(card)).toMatchObject({ state: 'denied', code: 'revoked' });
    expect((await w.login('astra@test.true')).status).toBe(401);
    // Its private key is gone from the database.
    expect(JSON.stringify(w.coreDb.prepare('SELECT private_jwk FROM institution_keys WHERE institution_id = ?').all(institution.id))).toBe('[{"private_jwk":"{}"}]');
  });

  it('the audit log holds ids only: no names, emails or field values', async () => {
    const { id, institution } = await w.issueTo('aarav@test.true');
    await w.core.request(`/v1/institution/credentials/${id}/revoke`, json({ reason: 'violation' }, institution.token));
    const log = JSON.stringify(w.coreDb.prepare('SELECT * FROM audit_events').all());
    for (const personal of ['Aarav', 'aarav@test.true', 'AIT2023001', 'Lake View', 'B+', '+91']) expect(log).not.toContain(personal);
    const events = (await (await w.core.request('/v1/institution/activity', auth(institution.token))).json()).events as { type: string; subject: string }[];
    expect(events.filter((e) => e.subject === id).map((e) => e.type).sort()).toEqual(['credential.accepted', 'credential.offered', 'credential.revoked']);
  });
});
