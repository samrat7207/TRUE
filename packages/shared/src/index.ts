// Shared constants. Nothing secret lives here: every app and service imports this file.
import brand from './brand.json' with { type: 'json' };

// Product name, full form and tagline. brand.json is the single source of truth.
export const BRAND = brand;

// Where each piece runs on the demo laptop.
export const URLS = {
  issuerApi: 'http://localhost:4001',
  verifierApi: 'http://localhost:4000', // front door; forwards to instance 4002 or 4012
  wallet: 'http://localhost:5173',
  issuerWeb: 'http://localhost:5174',
  verifierWeb: 'http://localhost:5175',
};

export const ISSUER_ID = 'issuer:astra-institute';
export const ISSUER_NAME = 'Astra Institute of Technology';
export const CREDENTIAL_TYPE = 'StudentCredential';

// Raw claims are copied from the issuer's student row.
export const RAW_CLAIMS = ['name', 'pnr', 'dob', 'address', 'class', 'section', 'branch', 'photo', 'institution'];
// Derived claims are yes/no facts the issuer computes, so a verifier never needs the raw data behind them.
export const DERIVED_CLAIMS = ['is_student', 'age_over_18'];
export const ALL_CLAIMS = [...RAW_CLAIMS, ...DERIVED_CLAIMS];

// Human-readable names for the consent screen.
export const CLAIM_LABELS: Record<string, string> = {
  name: 'Full name',
  pnr: 'PNR (student number)',
  dob: 'Date of birth',
  address: 'Home address',
  class: 'Class',
  section: 'Section',
  branch: 'Branch',
  photo: 'Photo',
  institution: 'Institution',
  is_student: 'Is a current student',
  age_over_18: 'Is over 18',
};

// One JSON error shape for every API.
export type ApiError = { error: { code: string; message: string } };

export { orHex, setBit, isBitSet } from './bits.ts';

// Where the issuer publishes its revocation list (the whole list, same file for everyone).
export const STATUS_LIST_URL = URLS.issuerApi + '/v1/status-list';
// Local chain (Hardhat node) JSON-RPC address.
export const CHAIN_RPC_URL = 'http://localhost:8545';

export { runLoadTest, LOAD_TEST_VERIFIER_ID, type LoadTestStats } from './loadtest.ts';
