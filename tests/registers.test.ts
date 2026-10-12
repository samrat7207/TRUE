// Registers: a check pinned to ONE institution and ONE ID type, enforced on the server.
import { beforeEach, describe, expect, it } from 'vitest';
import { answerRequest, loadRequest, setWalletOwner, type StoredCredential } from '@true/wallet-core';
import { FIELDS, auth, json, world } from './helpers.ts';

let w: Awaited<ReturnType<typeof world>>;
let ownerToken: string; // Isha owns the register
let astraId: string;
let registerId: string;

beforeEach(async () => {
  w = await world();
  ownerToken = (await w.login('isha@test.true')).token;
  astraId = (await w.login('astra@test.true')).id;
  // A gate register: Astra's Student ID only, asking for name and blood group.
  const created = await w.verifier.request('/v1/registers', json({
    name: 'Hostel gate', purpose: 'Entry to the hostel', issuerId: astraId, issuerName: 'Astra Institute of Technology', type: 'StudentID', fields: ['name', 'blood_group'],
  }, ownerToken));
  registerId = (await created.json()).register.id;
});

// The register's QR icon: a fresh request. Then the holder answers it with this card.
const newRequest = async (body: object = {}) => w.verifier.request(`/v1/registers/${registerId}/requests`, json(body, ownerToken));
async function presentTo(card: StoredCredential) {
  const { requestUri } = await (await newRequest()).json();
  const check = await loadRequest({ requestUri, fetch: w.fetchStub, getVerifier: (id) => w.verifierRegistry.get(id) ?? null });
  if (check.status !== 'verified') throw new Error(`request not authenticated: ${check.status}`);
  return { check, answer: await answerRequest({ check, stored: card, approve: true, fetch: w.fetchStub }) };
}

describe('registers', () => {
  it('a gym card with the same name and blood group is DENIED at a register pinned to the college Student ID', async () => {
    const gym = await w.issueTo('aarav@test.true', 'gym@test.true', 'GymMembership');
    expect(FIELDS.GymMembership.name).toBe(FIELDS.StudentID.name); // identical values on purpose
    expect(FIELDS.GymMembership.blood_group).toBe(FIELDS.StudentID.blood_group);
    const { answer } = await presentTo(gym.card);
    expect(answer).toMatchObject({ state: 'denied', code: 'wrong_issuer' });
    // Same institution but another ID type is refused too.
    const library = await w.issueTo('aarav@test.true', 'astra@test.true', 'LibraryCard', { ...FIELDS.LibraryCard, blood_group: 'B+' } as never).catch(() => null);
    expect(library).toBeNull(); // (a Library Card cannot even carry a blood group: the template forbids it)
  });

  it('a Student ID from a different institution is DENIED', async () => {
    const other = await w.issueTo('aarav@test.true', 'gym@test.true', 'StudentID'); // same type, same fields, wrong issuer
    expect((await presentTo(other.card)).answer).toMatchObject({ state: 'denied', code: 'wrong_issuer' });
  });

  it('the right card is Verified, and the holder is shown the register, its owner, institution and ID type', async () => {
    const right = await w.issueTo('aarav@test.true', 'astra@test.true', 'StudentID');
    const { check, answer } = await presentTo(right.card);
    expect(check.request.register).toMatchObject({ name: 'Hostel gate', owner: 'Isha Kulkarni', issuerId: astraId, issuerName: 'Astra Institute of Technology', type: 'StudentID' });
    expect(check.request.claims).toEqual(['name', 'blood_group']);
    expect(answer).toMatchObject({ state: 'verified', sharedClaims: ['name', 'blood_group'] });
    // A wrong ID type from the right institution: denied with its own code.
    const library = await w.issueTo('aarav@test.true', 'astra@test.true', 'LibraryCard');
    setWalletOwner(library.person.id);
    const pinnedToName = await w.verifier.request('/v1/registers', json({ name: 'Name check', purpose: 'Roll call', issuerId: astraId, issuerName: 'Astra Institute of Technology', type: 'StudentID', fields: ['name'] }, ownerToken));
    registerId = (await pinnedToName.json()).register.id;
    expect((await presentTo(library.card)).answer).toMatchObject({ state: 'denied', code: 'wrong_credential_type' });
  });

  it("a deleted register's QR stops working, and every QR is fresh", async () => {
    const right = await w.issueTo('aarav@test.true', 'astra@test.true', 'StudentID');
    const first = await (await newRequest()).json();
    const second = await (await newRequest()).json();
    expect(first.requestId).not.toBe(second.requestId); // a new request (and nonce) every time
    expect(new Date(first.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(2 * 60_000);

    // Only the owner can delete it.
    const stranger = (await w.login('aarav@test.true')).token;
    expect((await w.verifier.request(`/v1/registers/${registerId}/delete`, json({}, stranger))).status).toBe(404);
    expect((await w.verifier.request(`/v1/registers/${registerId}/delete`, json({}, ownerToken))).status).toBe(200);

    expect((await w.verifier.request(new URL(first.requestUri).pathname)).status).toBe(404); // the old QR is dead
    expect((await newRequest()).status).toBe(404); // and no new one can be made
    expect((await (await w.verifier.request('/v1/registers', auth(ownerToken))).json()).registers).toEqual([]);
    void right;
  });

  it("fields beyond the register's configured fields are refused", async () => {
    const tooMuch = await newRequest({ claims: ['name', 'blood_group', 'address'] });
    expect(tooMuch.status).toBe(400);
    expect((await tooMuch.json()).error.code).toBe('beyond_register');
    expect((await newRequest({ claims: ['name'] })).status).toBe(201); // fewer is fine
    // And a register cannot be set up with fields that are not in the ID type's template.
    const bad = await w.verifier.request('/v1/registers', json({ name: 'Bad', purpose: 'Bad', issuerId: astraId, issuerName: 'Astra', type: 'LibraryCard', fields: ['name', 'address'] }, ownerToken));
    expect(bad.status).toBe(400);
  });
});
