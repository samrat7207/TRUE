// Shared set-up for the tests: the core API and a verifier running in-process, with an in-memory
// stand-in for the chain registry. The "wallet" is the real packages/wallet-core code.
import { STATUS_LIST_URL, URLS, TEMPLATES } from '@true/shared';
import { sha256Hex, type IssuerKeyInfo, type Jwk } from '@true/credentials';
import {
  acceptOffer, answerRequest, getCredentials, loadRequest, setWalletOwner, useMemoryStorage, type Api, type Fetch, type StoredCredential,
} from '@true/wallet-core';
import { openCoreDb } from '../services/issuer-api/src/db.ts';
import { createCoreApp, type CoreChain, type SeedAccount } from '../services/issuer-api/src/app.ts';
import { openVerifierDb, DEMO_VERIFIERS } from '../services/verifier-api/src/db.ts';
import { createVerifierApp, type InstanceOptions } from '../services/verifier-api/src/app.ts';
import { refreshStatusList } from '../services/verifier-api/src/sync.ts';
import { generateSigningKeyPair, type VerifierInfo } from '@true/credentials';

// Test-only password. The demo's passwords live in .env, never in code.
export const PASSWORD = 'test-password-1';
export const SEED: SeedAccount[] = [
  { kind: 'institution', name: 'Astra Institute of Technology', email: 'astra@test.true', category: 'college', verified: true, password: PASSWORD },
  { kind: 'institution', name: 'IronWorks Gym', email: 'gym@test.true', category: 'gym', verified: true, password: PASSWORD },
  { kind: 'person', name: 'Aarav Deshmukh', email: 'aarav@test.true', password: PASSWORD },
  { kind: 'person', name: 'Isha Kulkarni', email: 'isha@test.true', password: PASSWORD },
];

// Example field values for each template (all invented).
export const FIELDS: Record<string, Record<string, string>> = {
  StudentID: {
    name: 'Aarav Deshmukh', id_number: 'AIT2023001', dob: '2005-03-14', address: '12 Lake View Road, Pune', blood_group: 'B+',
    class: 'TE', section: 'A', branch: 'Computer Engineering', parent_phone: '+91 90000 00001', emergency_contact: '+91 90000 00002',
  },
  LibraryCard: { name: 'Aarav Deshmukh', id_number: 'LIB-0042', valid_till: '2027-05-31' },
  GymMembership: { name: 'Aarav Deshmukh', member_id: 'IW-7781', dob: '2005-03-14', blood_group: 'B+', plan: 'Annual', valid_till: '2027-01-31' },
  EmployeeID: { name: 'Aarav Deshmukh', employee_id: 'NL-0310', department: 'Platform', dob: '2005-03-14' },
};

export const json = (body: unknown, token?: string, extra: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
  body: JSON.stringify(body),
});
export const auth = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

export async function world(verifierOptions: InstanceOptions = {}) {
  useMemoryStorage();
  let time = Date.now();
  // Stand-in for the chain: institution keys, names and verified flags, and the revocation fingerprint.
  const chainState = {
    keys: new Map<string, IssuerKeyInfo>(), // "<institution id>/<key id>"
    names: new Map<string, string>(),
    verified: new Map<string, boolean>(),
    anchorHash: '',
  };
  const chain: CoreChain = {
    registerInstitution: async (id, name) => chainState.names.set(id, name),
    setVerified: async (id, verified) => chainState.verified.set(id, verified),
    addIssuerKey: async (id, keyId, publicJwk) => chainState.keys.set(`${id}/${keyId}`, { publicJwk, state: 'Active' }),
    setIssuerKeyState: async (id, keyId, state) => { chainState.keys.get(`${id}/${keyId}`)!.state = state; },
    anchorStatusList: async (hash) => { chainState.anchorHash = hash; },
  };
  const getIssuerKey = (id: string, keyId: string) => chainState.keys.get(`${id}/${keyId}`) ?? null;

  const coreDb = openCoreDb(':memory:');
  const created = await createCoreApp(coreDb, chain, {
    seedAccounts: SEED, now: () => time, getSource: (c) => c.req.header('x-test-source') ?? 'unknown',
  });
  const core = created.app;

  // Demo verifiers sign their requests; only the ones marked registered are in the "registry".
  const verifierKeys: Record<string, Jwk> = {};
  const verifierRegistry = new Map<string, VerifierInfo>();
  for (const v of DEMO_VERIFIERS) {
    const pair = await generateSigningKeyPair();
    verifierKeys[v.id] = pair.privateJwk;
    if (v.registered) verifierRegistry.set(v.id, { name: v.name, allowedClaims: v.claims, publicJwk: pair.publicJwk });
  }
  const verifierDb = openVerifierDb(':memory:');
  const verifier = createVerifierApp(verifierDb, getIssuerKey, { verifierKeys, getSessionKey: () => created.sessionPublicJwk, ...verifierOptions });

  // The wallet's network: core API addresses go to the core app, everything else to the verifier.
  const fetchStub: Fetch = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search;
    return url.startsWith(URLS.coreApi) ? core.request(path, init) : verifier.request(path, init);
  };

  async function login(email: string, password = PASSWORD) {
    const response = await core.request('/v1/auth/login', json({ email, password }));
    const body = await response.json();
    return { token: body.token as string, id: body.account?.id as string, status: response.status, body };
  }
  const apiFor = (token: string): Api => ({ coreApi: URLS.coreApi, token, fetch: fetchStub });

  // Institution makes an offer; returns the credential id.
  async function offer(institutionToken: string, email: string, template = 'StudentID', fields = FIELDS[template]) {
    const response = await core.request('/v1/institution/offers', json({ email, template, fields }, institutionToken));
    return { id: (await response.clone().json()).id as string, response };
  }

  // The whole happy path: an institution issues to a person, who accepts on their device.
  async function issueTo(personEmail: string, institutionEmail = 'astra@test.true', template = 'StudentID', fields = FIELDS[template]) {
    const institution = await login(institutionEmail);
    const person = await login(personEmail);
    const { id } = await offer(institution.token, personEmail, template, fields);
    setWalletOwner(person.id);
    const card = await acceptOffer(apiFor(person.token), id);
    return { id, card, person, institution };
  }

  // The holder answers a demo verifier's request with this card (wallet owner must be set to the holder).
  async function present(card: StoredCredential, verifierId = 'verifier:campus-store', app = verifier) {
    const { requestUri } = await (await app.request('/v1/requests', json({ verifierId }))).json();
    const check = await loadRequest({ requestUri, fetch: fetchStub, getVerifier: (id) => verifierRegistry.get(id) ?? null });
    if (check.status !== 'verified') throw new Error(`request not authenticated: ${check.status}`);
    return answerRequest({ check, stored: card, approve: true, fetch: fetchStub });
  }

  // What each verifier instance does on its timer: download the list, accept it only if it matches the chain.
  async function refreshRevocations(db = verifierDb) {
    const list = await (await core.request(new URL(STATUS_LIST_URL).pathname)).json();
    return refreshStatusList(db, { fetchList: async () => list, getAnchorHash: async () => chainState.anchorHash, hash: sha256Hex });
  }

  return {
    core, coreDb, verifier, verifierDb, sessionPublicJwk: created.sessionPublicJwk, chainState, verifierRegistry, verifierKeys, getIssuerKey, fetchStub,
    login, apiFor, offer, issueTo, present, refreshRevocations, getCredentials,
    advance: (seconds: number) => { time += seconds * 1000; },
    templates: TEMPLATES,
  };
}
