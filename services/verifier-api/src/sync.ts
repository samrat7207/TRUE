// State sharing between the two verifier instances.
// Each instance has its own database. After every change it sends the changed rows to the other one.
// Merging is idempotent: receiving the same data twice changes nothing.
// Nothing shared here contains personal data: disclosed claim values are stripped before sending.
import type { DatabaseSync } from 'node:sqlite';
import { LOAD_TEST_VERIFIER_ID, isBitSet, orHex, setBit } from '@true/shared';
import type { RequestRow } from './db.ts';

export type AuditEvent = { id: string; ts: string; type: string; request_id: string; instance: string };
export type SharedRequest = Omit<RequestRow, 'result_json'> & { result: Record<string, unknown> | null };
export type SharedState = {
  requests?: SharedRequest[];
  statusBitsHex?: string;
  auditEvents?: AuditEvent[];
  deleteLoadTest?: boolean; // "the load test is over: delete its synthetic requests"
};

// Removes every synthetic load-test request from this instance.
export const deleteLoadTestRequests = (db: DatabaseSync) => db.prepare('DELETE FROM requests WHERE verifier_id = ?').run(LOAD_TEST_VERIFIER_ID);

// A request as the other instance may see it: outcome and reason code, but never the disclosed claims.
export function toShared(row: RequestRow): SharedRequest {
  const { result_json, ...rest } = row;
  const result = result_json ? JSON.parse(result_json) : null;
  if (result) delete result.claims;
  return { ...rest, result };
}

// ---------- status list (one bit per credential, 1 = revoked), stored as a hex string ----------

export function getStatusBits(db: DatabaseSync): string {
  const row = db.prepare('SELECT bits_hex FROM status_list WHERE id = 1').get() as { bits_hex: string } | undefined;
  return row?.bits_hex ?? '';
}

const saveStatusBits = (db: DatabaseSync, hex: string) =>
  db.prepare('INSERT INTO status_list (id, bits_hex) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET bits_hex = excluded.bits_hex').run(hex);

export const setRevoked = (db: DatabaseSync, index: number) => saveStatusBits(db, setBit(getStatusBits(db), index));
export const isRevoked = (db: DatabaseSync, index: number) => isBitSet(getStatusBits(db), index);

// Scheduled revocation refresh. Downloads the issuer's whole public list, and accepts it ONLY if its
// fingerprint equals the one the issuer anchored on the chain. Accepted bits are OR-ed into our copy.
// Returns what happened, and the merged bits when something changed (so the caller can share them).
export async function refreshStatusList(db: DatabaseSync, source: {
  fetchList: () => Promise<{ bitsHex: string }>; // the issuer's public status-list file
  getAnchorHash: () => Promise<string>; // fingerprint from the chain registry
  hash: (text: string) => string; // SHA-256 (from packages/credentials)
}): Promise<'updated' | 'unchanged' | 'mismatch'> {
  const list = await source.fetchList();
  if (source.hash(list.bitsHex) !== (await source.getAnchorHash())) return 'mismatch';
  const merged = orHex(getStatusBits(db), list.bitsHex);
  if (merged === getStatusBits(db)) return 'unchanged';
  saveStatusBits(db, merged);
  return 'updated';
}

// ---------- audit events ----------

export function addAuditEvent(db: DatabaseSync, event: AuditEvent): void {
  // The id is the primary key, so inserting the same event twice is ignored: a union without duplicates.
  db.prepare('INSERT OR IGNORE INTO audit_events (id, ts, type, request_id, instance) VALUES (?, ?, ?, ?, ?)').run(
    event.id, event.ts, event.type, event.request_id, event.instance,
  );
}

// ---------- export and merge ----------

// Everything this instance knows (used when the other instance restarts and needs to catch up).
export function exportState(db: DatabaseSync): SharedState {
  return {
    // Synthetic load-test requests are not part of the normal request list.
    requests: (db.prepare('SELECT * FROM requests WHERE verifier_id != ?').all(LOAD_TEST_VERIFIER_ID) as RequestRow[]).map(toShared),
    statusBitsHex: getStatusBits(db),
    auditEvents: db.prepare('SELECT * FROM audit_events').all() as AuditEvent[],
  };
}

export function mergeState(db: DatabaseSync, incoming: SharedState): void {
  for (const request of incoming.requests ?? []) {
    const local = db.prepare('SELECT * FROM requests WHERE id = ?').get(request.id) as RequestRow | undefined;
    const resultJson = request.result ? JSON.stringify(request.result) : null;
    if (!local) {
      db.prepare(
        'INSERT INTO requests (id, verifier_id, claims_json, nonce, state, created_at, expires_at, updated_at, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(request.id, request.verifier_id, request.claims_json, request.nonce, request.state, request.created_at, request.expires_at, request.updated_at, resultJson);
    } else if (request.updated_at > local.updated_at) {
      // Latest status wins. Equal or older timestamps are ignored, which makes repeats harmless.
      db.prepare('UPDATE requests SET state = ?, result_json = ?, updated_at = ? WHERE id = ?').run(
        request.state, resultJson, request.updated_at, request.id,
      );
    }
  }
  if (incoming.deleteLoadTest) deleteLoadTestRequests(db);
  if (incoming.statusBitsHex) saveStatusBits(db, orHex(getStatusBits(db), incoming.statusBitsHex));
  for (const event of incoming.auditEvents ?? []) addAuditEvent(db, event);
}
