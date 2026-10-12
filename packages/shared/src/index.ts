// Shared constants. Nothing secret lives here: every app and service imports this file.
import brand from './brand.json' with { type: 'json' };

// Product name, full form and tagline. brand.json is the single source of truth.
export const BRAND = brand;

// Where each piece runs on the demo laptop.
export const URLS = {
  coreApi: 'http://localhost:4001', // accounts, institutions, issuing, offers
  verifierApi: 'http://localhost:4000', // front door; forwards to instance 4002, 4012 or 4022
  app: 'http://localhost:5176', // the app (people and institutions)
  ops: 'http://localhost:5175', // operations console for the verifier servers
};

// The one revocation list kept by the issuing service for every institution it hosts.
// Its fingerprint is anchored on the chain under this id.
export const STATUS_LIST_ID = 'service:true-issuance';
export const STATUS_LIST_URL = URLS.coreApi + '/v1/status-list';
// Local chain (Hardhat node) JSON-RPC address.
export const CHAIN_RPC_URL = 'http://localhost:8545';

// ---------- credential templates ----------
// An institution picks a template when it issues. Every field becomes its own selectively disclosable claim.
export type Template = { label: string; fields: string[] };
export const TEMPLATES: Record<string, Template> = {
  StudentID: { label: 'Student ID', fields: ['name', 'id_number', 'dob', 'address', 'blood_group', 'class', 'section', 'branch', 'parent_phone', 'emergency_contact'] },
  LibraryCard: { label: 'Library Card', fields: ['name', 'id_number', 'valid_till'] },
  GymMembership: { label: 'Gym Membership', fields: ['name', 'member_id', 'dob', 'blood_group', 'plan', 'valid_till'] },
  EmployeeID: { label: 'Employee ID', fields: ['name', 'employee_id', 'department', 'dob'] },
};
export const templateLabel = (type: string) => TEMPLATES[type]?.label ?? type;

// Human-readable names for every field.
export const CLAIM_LABELS: Record<string, string> = {
  name: 'Full name',
  id_number: 'ID number',
  member_id: 'Member ID',
  employee_id: 'Employee ID',
  dob: 'Date of birth',
  address: 'Home address',
  blood_group: 'Blood group',
  class: 'Class',
  section: 'Section',
  branch: 'Branch',
  parent_phone: "Parent's phone",
  emergency_contact: 'Emergency contact',
  valid_till: 'Valid till',
  plan: 'Membership plan',
  department: 'Department',
};
// Fields that deserve a warning before they are shared.
export const SENSITIVE_CLAIMS = ['address', 'parent_phone', 'emergency_contact', 'blood_group'];
// Fields entered as a date.
export const DATE_CLAIMS = ['dob', 'valid_till'];

export const INSTITUTION_CATEGORIES: Record<string, string> = { college: 'College', gym: 'Gym', company: 'Company', other: 'Other' };

// One JSON error shape for every API.
export type ApiError = { error: { code: string; message: string } };

export { orHex, setBit, isBitSet } from './bits.ts';
export { runLoadTest, LOAD_TEST_VERIFIER_ID, type LoadTestStats } from './loadtest.ts';
export { createFailureLimiter, createRateCounter } from './ratelimit.ts';
