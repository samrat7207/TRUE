// Servers section: the three verifier instances behind the front door, the rate limit, and the load test.
// Every number here is read from the front door's /proxy/status once a second.
import { useState } from 'react';
import { runLoadTest, type LoadTestStats } from '@true/shared';
import { Badge, Card } from '../ui.tsx';
import { FRONT_DOOR, Section, SmallButton, duration, getJson, useEvery } from './parts.tsx';

type Instance = { name: string; port: number; alive: boolean; lastSyncedAt?: number | null; served?: number; failures?: number; uptimeSeconds?: number };
type Status = {
  instances: Instance[];
  now: number;
  blocked: { active: number; total: number; recent: { at: string; source: string; verifierId: string; seconds: number }[] };
  limits: { failMax: number; failWindowSeconds: number; blockSeconds: number; createMax: number };
};

export function Servers() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loaded, setLoaded] = useState(false);
  const refresh = () => getJson<Status>(`${FRONT_DOOR}/proxy/status`).then((next) => { setStatus(next); setLoaded(true); });
  useEvery(refresh, 1000);

  // name is an instance number, or "all".
  const act = (action: 'kill' | 'restart', name: string) => fetch(`${FRONT_DOOR}/proxy/${action}/${name}`, { method: 'POST' }).then(refresh, refresh);

  if (!status) {
    return (
      <Section id="servers" title="Servers">
        <Card tone={loaded ? 'bad' : 'plain'}>
          {loaded ? <><b>The front door (port 4000) is not reachable.</b> Is "npm run dev" running? This page keeps trying.</> : 'Loading…'}
        </Card>
      </Section>
    );
  }

  const alive = status.instances.filter((i) => i.alive).length;
  const total = status.instances.length;
  const cluster = alive === total
    ? { label: 'Normal', tone: 'ok' as const, text: `All ${total} instances are alive. Requests are shared between them in turn.` }
    : alive > 0
      ? { label: 'Degraded', tone: 'warn' as const, text: `${alive} of ${total} instances alive. The others' work is taken over; checks keep working.` }
      : { label: 'Offline', tone: 'bad' as const, text: 'No instance is alive. Checks answer "No server available" until one is restarted.' };

  return (
    <>
      <Section
        id="servers" title="Servers" note="Verifier instances behind the front door (port 4000)"
        right={<div className="flex gap-2"><SmallButton kind="danger" disabled={alive === 0} onClick={() => act('kill', 'all')}>Kill all</SmallButton><SmallButton disabled={alive === total} onClick={() => act('restart', 'all')}>Restart all</SmallButton></div>}
      >
        <Card tone={cluster.tone} className="mb-3 flex items-center gap-3">
          <Badge tone={cluster.tone}>{cluster.label}</Badge>
          <span className="text-small">{cluster.text}</span>
          <span className="ml-auto shrink-0 text-small font-semibold">{alive} of {total} alive</span>
        </Card>

        <div className="mb-3 grid grid-cols-3 gap-3">
          {status.instances.map((i) => (
            <Card key={i.name} tone={i.alive ? 'plain' : 'bad'}>
              <div className="mb-3 flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full ${i.alive ? 'bg-ok' : 'bg-bad'}`} />
                <span className="font-semibold">Instance {i.name}</span>
                <span className="text-small text-muted">:{i.port}</span>
                <span className={`ml-auto text-small font-semibold ${i.alive ? 'text-ok' : 'text-bad'}`}>{i.alive ? 'alive' : 'dead'}</span>
              </div>
              <dl className="mb-4 grid grid-cols-2 gap-x-3 gap-y-1 text-small">
                <dt className="text-muted">Requests served</dt><dd className="text-right font-mono">{i.served ?? 0}</dd>
                <dt className="text-muted">Failures</dt><dd className="text-right font-mono">{i.failures ?? 0}</dd>
                <dt className="text-muted">Uptime</dt><dd className="text-right font-mono">{i.alive ? duration(i.uptimeSeconds ?? 0) : '—'}</dd>
                <dt className="text-muted">Last synced</dt>
                <dd className="text-right font-mono">{i.lastSyncedAt ? `${duration(Math.max(0, Math.round((status.now - i.lastSyncedAt) / 1000)))} ago` : 'not yet'}</dd>
              </dl>
              <div className="flex gap-2">
                <SmallButton kind="danger" disabled={!i.alive} onClick={() => act('kill', i.name)}>Kill</SmallButton>
                <SmallButton disabled={i.alive} onClick={() => act('restart', i.name)}>Restart</SmallButton>
              </div>
            </Card>
          ))}
        </div>

        <Card>
          <div className="flex items-center gap-3">
            <span className="font-semibold">Rate limiting</span>
            <span className="text-small text-muted">
              {status.limits.failMax} failed attempts in {status.limits.failWindowSeconds}s block a source for {status.limits.blockSeconds}s · at most {status.limits.createMax} new requests per source per minute
            </span>
          </div>
          <div className="mt-3 flex gap-6 text-small">
            <span>Blocked sources now: <b className={status.blocked.active > 0 ? 'text-bad' : ''}>{status.blocked.active}</b></span>
            <span>Blocks since start: <b>{status.blocked.total}</b></span>
          </div>
          {status.blocked.recent.map((event) => (
            <div key={event.at + event.source} className="mt-1 font-mono text-tiny text-muted">
              {new Date(event.at).toLocaleTimeString('en-GB')} · source {event.source} · {event.verifierId} · {event.seconds}s
            </div>
          ))}
        </Card>
      </Section>

      <LoadTest disabled={alive === 0} />
    </>
  );
}

// "Run load test": synthetic requests through the front door, as the clearly-labelled load-test verifier.
// Each is created once and polled once. The bars show which instance served each call.
function LoadTest({ disabled }: { disabled: boolean }) {
  const [stats, setStats] = useState<LoadTestStats | null>(null);
  const run = () => runLoadTest((path, init) => fetch(FRONT_DOOR + path, init), setStats);
  const busiest = stats ? Math.max(1, ...Object.values(stats.perInstance)) : 1;
  return (
    <Section
      id="load-test" title="Load test" note='Synthetic requests as "Load test (synthetic)": each is created once and polled once, then deleted. Not real verifications.'
      right={<SmallButton onClick={run} disabled={disabled || stats?.running}>{stats?.running ? 'Running…' : 'Run load test'}</SmallButton>}
    >
      <Card>
        {!stats && <span className="text-small text-muted">Not run yet. Kill an instance while it runs to see the others take over.</span>}
        {stats && (
          <>
            <div className="space-y-2">
              {Object.entries(stats.perInstance).sort().map(([name, count]) => (
                <div key={name} className="flex items-center gap-3 text-small">
                  <span className="w-20 text-muted">{name}</span>
                  <div className="h-3 flex-1 rounded-pill bg-soft"><div className="h-3 rounded-pill bg-ink transition-all" style={{ width: `${(count / busiest) * 100}%` }} /></div>
                  <span className="w-8 text-right font-mono">{count}</span>
                </div>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-small">
              <span>Calls: <b>{stats.calls} of {stats.totalCalls}</b></span>
              <span>Average: <b>{stats.averageMs} ms</b></span>
              <span>Slowest: <b>{stats.slowestMs} ms</b></span>
              <span>Failures: <b className={stats.failures > 0 ? 'text-bad' : 'text-ok'}>{stats.failures}</b></span>
              {!stats.running && <span className="text-muted">Finished; synthetic requests deleted.</span>}
            </div>
          </>
        )}
      </Card>
    </Section>
  );
}
