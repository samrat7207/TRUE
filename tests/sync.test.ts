// Verifier instances with separate databases that share state.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openVerifierDb } from '../services/verifier-api/src/db.ts';
import { createVerifierApp } from '../services/verifier-api/src/app.ts';
import { exportState, getStatusBits, mergeState, refreshStatusList, type SharedState } from '../services/verifier-api/src/sync.ts';
import { sha256Hex } from '@true/credentials';
import { json, world } from './helpers.ts';

const KEY = 'test-internal-key';
type App = ReturnType<typeof createVerifierApp>;

// Three instances. Each sends every change to ALL peers and ignores the ones that are down (same rule as server.ts).
async function cluster() {
  const w = await world();
  const apps: App[] = [];
  const dbs = [0, 1, 2].map(() => openVerifierDb(':memory:'));
  const alive = [true, true, true];
  dbs.forEach((db, self) => {
    apps.push(createVerifierApp(db, w.getIssuerKey, {
      instance: String(self + 1), internalKey: KEY, verifierKeys: w.verifierKeys,
      sendToPeer: async (state: SharedState) => {
        if (!alive[self]) throw new Error('down');
        const results = await Promise.allSettled(apps.map(async (peer, i) => {
          if (i === self) return;
          if (!alive[i]) throw new Error('down');
          await peer.request('/internal/sync', json(state, undefined, { 'x-internal-key': KEY }));
        }));
        if (!results.some((r) => r.status === 'fulfilled')) throw new Error('no peer');
      },
    }));
  });
  return { w, apps, dbs, alive };
}

describe('verifier instances', () => {
  it('create a request on 1, kill 1 and 2, approve through 3: still verified', async () => {
    const { w, apps, alive } = await cluster();
    const { card } = await w.issueTo('aarav@test.true');
    const { requestId, requestUri } = await (await apps[0].request('/v1/requests', json({ verifierId: 'verifier:campus-store' }))).json();
    alive[0] = false;
    alive[1] = false;
    // The wallet's calls now land on instance 3, which already knows the request and its nonce.
    const { loadRequest, answerRequest } = await import('@true/wallet-core');
    const toThree = async (url: string, init?: object) => apps[2].request(new URL(url).pathname, init);
    const check = await loadRequest({ requestUri, fetch: toThree, getVerifier: (id) => w.verifierRegistry.get(id) ?? null });
    if (check.status !== 'verified') throw new Error('expected an authenticated request');
    expect((await answerRequest({ check, stored: card, approve: true, fetch: toThree })).state).toBe('verified');
    expect((await (await apps[2].request(`/v1/requests/${requestId}`)).json()).state).toBe('verified');
    // The same answer replayed on another instance is refused, and shared data never holds the disclosed claims.
    expect(JSON.stringify(exportState(w.verifierDb))).not.toContain('Aarav');
  });

  it('a revocation learned by one instance reaches the others, and merging old data never un-revokes', async () => {
    const { apps, dbs } = await cluster();
    const before = exportState(dbs[1]);
    await apps[0].request('/internal/status/revoke', json({ index: 5 }, undefined, { 'x-internal-key': KEY }));
    expect((await (await apps[1].request('/v1/status/5')).json()).revoked).toBe(true);
    expect((await (await apps[2].request('/v1/status/4')).json()).revoked).toBe(false);
    mergeState(dbs[1], { statusBitsHex: '00' });
    mergeState(dbs[1], before);
    expect((await (await apps[1].request('/v1/status/5')).json()).revoked).toBe(true);
  });

  it('a revocation list that does not match the chain fingerprint is ignored', async () => {
    const { dbs } = await cluster();
    const before = getStatusBits(dbs[0]);
    expect(await refreshStatusList(dbs[0], { fetchList: async () => ({ bitsHex: 'ffff' }), getAnchorHash: async () => sha256Hex('00'), hash: sha256Hex })).toBe('mismatch');
    expect(getStatusBits(dbs[0])).toBe(before);
  });

  it('merging the same events twice does not duplicate them', async () => {
    const { apps, dbs } = await cluster();
    await apps[0].request('/v1/requests', json({ verifierId: 'verifier:campus-store' }));
    const state = exportState(dbs[0]);
    const count = (table: string) => (dbs[1].prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    mergeState(dbs[1], state);
    mergeState(dbs[1], state);
    expect([count('audit_events'), count('requests')]).toEqual([1, 1]);
  });

  it('the sync endpoint refuses callers without the internal key', async () => {
    const { apps } = await cluster();
    expect((await apps[0].request('/internal/sync', json({ requests: [] }))).status).toBe(403);
    expect((await apps[0].request('/internal/sync', json({ requests: [] }, undefined, { 'x-internal-key': 'wrong' }))).status).toBe(403);
  });

  it('kill all, restart one: it recovers from its own database file', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'true-')), 'verifier-1.db');
    let db = openVerifierDb(file);
    let app = createVerifierApp(db, () => null, { instance: '1', internalKey: KEY });
    const { requestId } = await (await app.request('/v1/requests', json({ verifierId: 'verifier:campus-store' }))).json();
    await app.request('/internal/status/revoke', json({ index: 3 }, undefined, { 'x-internal-key': KEY }));
    db.close();
    db = openVerifierDb(file);
    app = createVerifierApp(db, () => null, { instance: '1', internalKey: KEY });
    expect((await (await app.request(`/v1/requests/${requestId}`)).json()).state).toBe('pending');
    expect((await (await app.request('/v1/status/3')).json()).revoked).toBe(true);
    db.close();
  });
});
