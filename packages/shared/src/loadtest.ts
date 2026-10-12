// Load test client: creates synthetic verification requests through the front door, then polls them.
// Used by the "Run load test" button on the verifier page, and by the tests (which pass in-process calls).
// The requests belong to a clearly-labelled synthetic verifier, so they never mix with real ones.

export const LOAD_TEST_VERIFIER_ID = 'verifier:load-test';

export type LoadTestStats = {
  running: boolean;
  calls: number; // calls finished so far (each request is created once and polled once)
  totalCalls: number;
  failures: number;
  perInstance: Record<string, number>; // "instance 1" => how many calls it served
  averageMs: number;
  slowestMs: number;
};

// "call" sends one HTTP request to the front door and returns the response.
type Call = (path: string, init?: { method: string; headers: Record<string, string>; body: string }) => Promise<Response>;

export async function runLoadTest(call: Call, onProgress: (stats: LoadTestStats) => void, total = 50, concurrency = 5): Promise<LoadTestStats> {
  const stats: LoadTestStats = { running: true, calls: 0, totalCalls: total * 2, failures: 0, perInstance: {}, averageMs: 0, slowestMs: 0 };
  let totalMs = 0;
  const post = (body: object) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  // Make one call, time it, and note which instance answered (the front door's X-Served-By header).
  async function timed(path: string, init?: Parameters<Call>[1]): Promise<Response | null> {
    const started = performance.now();
    let response: Response | null = null;
    try { response = await call(path, init); } catch { /* network error: counted as a failure below */ }
    const ms = performance.now() - started;
    totalMs += ms;
    stats.calls += 1;
    stats.averageMs = Math.round(totalMs / stats.calls);
    stats.slowestMs = Math.max(stats.slowestMs, Math.round(ms));
    if (response?.ok) {
      const servedBy = response.headers.get('X-Served-By') ?? 'unknown';
      stats.perInstance[servedBy] = (stats.perInstance[servedBy] ?? 0) + 1;
    } else {
      stats.failures += 1;
    }
    onProgress({ ...stats, perInstance: { ...stats.perInstance } });
    return response;
  }

  // Run the jobs a few at a time, like several kiosks working at once.
  async function inBatches<T>(items: T[], job: (item: T) => Promise<void>) {
    const queue = [...items];
    await Promise.all(Array.from({ length: concurrency }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await job(item);
    }));
  }

  // Phase 1: create the requests. Phase 2: poll each one once.
  const requestIds: string[] = [];
  await inBatches(Array.from({ length: total }, (_, i) => i), async () => {
    const response = await timed('/v1/requests', post({ verifierId: LOAD_TEST_VERIFIER_ID }));
    if (response?.ok) requestIds.push((await response.json()).requestId);
  });
  await inBatches(requestIds, async (id) => { await timed(`/v1/requests/${id}`); });
  // A request that could not be created was never polled; count the missing poll so the totals add up.
  stats.calls += total - requestIds.length;

  // Clean up: delete the synthetic requests everywhere and leave ONE summary line in the audit log.
  await call('/v1/load-test/cleanup', post({ requests: total, failures: stats.failures })).catch(() => null);

  stats.running = false;
  const final = { ...stats, perInstance: { ...stats.perInstance } };
  onProgress(final);
  return final;
}
