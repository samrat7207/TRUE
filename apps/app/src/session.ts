// The logged-in account, and calls to the core API on its behalf.
// The server checks the session token on every call; this file only stores it and attaches it.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { URLS } from '@true/shared';
import { setWalletOwner, type Api } from '@true/wallet-core';

export type AccountInfo = { id: string; kind: 'person' | 'institution'; name: string; email: string; category: string | null; verified: boolean };
export type Session = { token: string; account: AccountInfo };

// Kept in localStorage: the token is valid for 30 days, so you stay logged in on this device.
const KEY = 'true-session';
const read = (): Session | null => JSON.parse(localStorage.getItem(KEY) ?? 'null');
// The wallet on this device belongs to whoever is logged in.
setWalletOwner(read()?.account.id ?? 'nobody');

// Screens that call useSession() are re-drawn whenever someone logs in or out, or the server ends the session.
const listeners = new Set<() => void>();
export function setSession(session: Session | null) {
  if (session) localStorage.setItem(KEY, JSON.stringify(session));
  else localStorage.removeItem(KEY);
  setWalletOwner(session?.account.id ?? 'nobody');
  listeners.forEach((notify) => notify());
}
export function useSession(): Session | null {
  const raw = useSyncExternalStore((notify) => { listeners.add(notify); return () => listeners.delete(notify); }, () => localStorage.getItem(KEY));
  return raw ? JSON.parse(raw) : null;
}
export const getSession = read;

export class ApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// GET (no body) or POST (with body) to the core API. Throws ApiError with the server's reason code and message.
export async function api<T = any>(path: string, body?: unknown): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const response = await fetch(URLS.coreApi + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${read()?.token ?? ''}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => { throw new ApiError('unreachable', 'The server is not reachable'); });
  const result = await response.json();
  // The account was deleted or the token ran out: back to the welcome screen.
  if (response.status === 401 && result.error?.code === 'not_signed_in') setSession(null);
  if (!response.ok) throw new ApiError(result.error?.code ?? 'error', result.error?.message ?? 'Request failed');
  return result;
}

// What packages/wallet-core needs to act as the logged-in person.
export const walletApi = (): Api => ({ coreApi: URLS.coreApi, token: read()?.token ?? '', fetch: (url, init) => fetch(url, init) });

// Load something from the core API when the screen opens. data is null while loading.
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

// Runs an action and reports the server's refusal, if any. Returns true when it worked.
export async function attempt(action: () => Promise<unknown>, setError: (message: string) => void): Promise<boolean> {
  try { await action(); return true; } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); return false; }
}
