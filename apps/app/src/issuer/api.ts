// Talking to the issuer API as a signed-in staff member.
// The server checks the session and the role on every call; hiding a button here is only for tidiness.
import { useCallback, useEffect, useState } from 'react';
import { URLS } from '@true/shared';
import { go } from '../ui.tsx';

export type StaffSession = { token: string; staff: { id: string; name: string; role: string; permissions: string[] } };

// The session lives in sessionStorage: it survives a page refresh and is gone when the tab closes.
// The server also ends it after 30 minutes.
const KEY = 'true-issuer-session';
export const getSession = (): StaffSession | null => JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
export const setSession = (session: StaffSession | null) => (session ? sessionStorage.setItem(KEY, JSON.stringify(session)) : sessionStorage.removeItem(KEY));

// May the signed-in staff member do this? Used to hide or disable buttons. The server decides for real.
export const can = (permission: 'issue' | 'revoke' | 'keys' | 'staff') => getSession()?.staff.permissions.includes(permission) ?? false;

export class ApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// GET (no body) or POST (with body). Throws ApiError with the server's reason code and message.
export async function api<T = any>(path: string, body?: unknown): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const response = await fetch(URLS.issuerApi + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${getSession()?.token ?? ''}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (response.status === 401 && result.error?.code === 'not_signed_in') {
    setSession(null); // session ended: back to the PIN screen
    go('/issuer');
  }
  if (!response.ok) throw new ApiError(result.error?.code ?? 'error', result.error?.message ?? 'Request failed');
  return result;
}

export async function signOut() {
  await api('/v1/staff/logout', {}).catch(() => {});
  setSession(null);
  go('/');
}

// Load something from the API when the screen opens. data is null while loading.
export function useApi<T = any>(path: string | null) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(() => {
    if (!path) return;
    api<T>(path).then(setData).catch((e) => setError(e.message));
  }, [path]);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

// ---------- shapes the API returns ----------

export type Student = { id: number; name: string; pnr: string; class: string; section: string; branch: string; status: string };
export type Credential = {
  id: string; student_id: number; type: string; display_status: 'pending' | 'active' | 'revoked' | 'replaced' | 'expired';
  claim_code: string; valid_from: string; valid_till: string; issued_by: string | null; created_at: string; claimed_at: string | null;
  status_list_index: number | null; revoked_reason: string | null; revoked_at: string | null; revoked_by: string | null;
  student_name: string; student_pnr: string; student_branch: string; student_status: string;
};
export type AuditEvent = { id: number; ts: string; type: string; staff_id: string | null; subject: string };

// ---------- words ----------

export const STATUS_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'neutral'> = { active: 'ok', pending: 'warn', revoked: 'bad', replaced: 'neutral', expired: 'neutral' };
export const STATUS_LABEL: Record<string, string> = { active: 'Active', pending: 'Pending', revoked: 'Revoked', replaced: 'Replaced', expired: 'Offer expired' };

export const REVOKE_REASONS: Record<string, string> = { lost: 'Lost / Stolen', no_longer_valid: 'No longer valid', violation: 'Violation of terms', duplicate: 'Duplicate issued', other: 'Other' };

// How each audit event type is shown in lists.
export const EVENT_LABEL: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
  'credential.offered': { label: 'Offer created', tone: 'warn' },
  'credential.claimed': { label: 'Issued', tone: 'ok' },
  'credential.revoked': { label: 'Revoked', tone: 'bad' },
  'student.revoked': { label: 'Student revoked', tone: 'bad' },
  'student.reinstated': { label: 'Given back', tone: 'ok' },
  'key.rotated': { label: 'Key rotated', tone: 'neutral' },
  'key.compromised': { label: 'Key compromised', tone: 'bad' },
  'staff.added': { label: 'Staff added', tone: 'neutral' },
  'staff.deactivated': { label: 'Staff deactivated', tone: 'neutral' },
  'staff.login': { label: 'Signed in', tone: 'neutral' },
  'staff.login_failed': { label: 'Wrong PIN', tone: 'bad' },
  'request.received': { label: 'Request received', tone: 'warn' },
  'request.approved': { label: 'Request approved', tone: 'ok' },
  'request.rejected': { label: 'Request rejected', tone: 'bad' },
};

export const shortDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const dateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

// "2 mins ago" style, from the device clock.
export function ago(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

// The student's batch, worked out from the year inside the PNR in the database (e.g. AIT2023001 -> 2023 – 2027).
export function batchOf(pnr: string): string {
  const year = Number(/\d{4}/.exec(pnr)?.[0]);
  return year ? `${year} – ${year + 4}` : '—';
}
