// Verifier screen: pick who you are, show a QR, and watch the result arrive live.
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { BRAND, CLAIM_LABELS, URLS, runLoadTest, type LoadTestStats } from '@true/shared';

type Verifier = { id: string; name: string; purpose: string; claims: string[] };
type Check = { requestId: string; walletUrl: string; qr: string };
type Status = { state: 'pending' | 'verified' | 'denied' | 'expired'; result: { claims?: Record<string, unknown>; issuer?: string; code?: string; message?: string } | null; servedBy?: string | null };

export default function App() {
  const [verifiers, setVerifiers] = useState<Verifier[]>([]);
  const [active, setActive] = useState<Verifier | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [overAsk, setOverAsk] = useState(false); // demo: also ask for the home address

  // Load the verifier list; keep trying every 2 seconds while no server is available.
  useEffect(() => {
    if (verifiers.length > 0) return;
    const load = () => fetch(URLS.verifierApi + '/v1/verifiers').then((r) => r.json()).then((b) => { if (b.verifiers) setVerifiers(b.verifiers); }).catch(() => {});
    load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [verifiers.length]);

  // Create a request (fresh nonce on the server) and draw the wallet link as a QR code.
  async function start(verifier: Verifier) {
    setActive(verifier);
    setStatus(null);
    setCheck(null);
    const response = await fetch(URLS.verifierApi + '/v1/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(overAsk ? { verifierId: verifier.id, claims: [...verifier.claims, 'address'] } : { verifierId: verifier.id }) }).catch(() => null);
    setUnavailable(!response || !response.ok);
    if (!response || !response.ok) return;
    const body = await response.json();
    setCheck({ requestId: body.requestId, walletUrl: body.walletUrl, qr: await QRCode.toDataURL(body.walletUrl, { width: 260, margin: 1 }) });
  }

  // Live update: ask the API once a second until the request is no longer pending.
  useEffect(() => {
    if (!check) return;
    let extraTries = 0;
    const timer = setInterval(async () => {
      const response = await fetch(`${URLS.verifierApi}/v1/requests/${check.requestId}`).catch(() => null);
      setUnavailable(!response || response.status === 503);
      if (!response || !response.ok) return;
      const next: Status = { ...(await response.json()), servedBy: response.headers.get('X-Served-By') };
      // Disclosed claims are never copied between instances, so only the instance that did the check has them.
      // Keep an answer that has the claims over a later one that does not.
      setStatus((previous) => (previous?.result?.claims && !next.result?.claims ? previous : next));
      // Stop when finished. For "verified", ask a few more times so the round-robin reaches the instance holding the claims.
      const hasClaims = Boolean(next.result?.claims);
      if (next.state !== 'pending' && (next.state !== 'verified' || hasClaims || ++extraTries > 6)) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [check]);

  return (
    <div className="mx-auto max-w-4xl p-6">
      <header className="mb-6 border-b border-slate-300 pb-4">
        <div className="text-xs uppercase tracking-wide text-slate-500">{BRAND.name} · Verifier</div>
        <h1 className="text-2xl font-bold">{active ? active.name : 'Choose a verifier'}</h1>
        <div className="text-sm text-slate-500">{BRAND.tagline}</div>
      </header>

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        {verifiers.map((v) => (
          <button key={v.id} onClick={() => start(v)} className={`rounded-xl border-2 bg-white p-4 text-left shadow-sm ${active?.id === v.id ? 'border-indigo-600' : 'border-transparent'}`}>
            <div className="font-semibold">{v.name}{v.id === 'verifier:free-prize-booth' && <span className="ml-2 rounded bg-rose-100 px-1.5 py-0.5 text-xs font-normal text-rose-700">not registered (phishing demo)</span>}</div>
            <div className="text-xs text-slate-500">{v.purpose}</div>
            <div className="mt-2 text-xs text-indigo-700">Asks for: {v.claims.map((c) => CLAIM_LABELS[c]).join(', ')}</div>
          </button>
        ))}
      </div>

      <label className="mb-6 flex items-center gap-2 text-sm text-slate-600">
        <input type="checkbox" checked={overAsk} onChange={(e) => setOverAsk(e.target.checked)} />
        Demo: over-ask (the next check also requests the home address; the wallet should flag and block it)
      </label>

      <InstancePanel />
      <LoadTest />

      {unavailable && <div className="mb-6 rounded-xl border-2 border-amber-400 bg-amber-50 p-4 text-amber-900"><b>No server available.</b> Every verifier instance is down. Restart one above; this page recovers on its own.</div>}

      {active && check && (
        <div className="grid gap-6 md:grid-cols-2">
          <div className="rounded-xl bg-white p-5 text-center shadow">
            <div className="mb-2 text-sm text-slate-600">Scan with your {BRAND.name} wallet</div>
            <img src={check.qr} alt="QR request" className="mx-auto" />
            <a href={check.walletUrl} target="true-wallet" className="mt-3 block rounded-lg bg-slate-800 py-2 text-sm text-white">Open in wallet (same laptop)</a>
            <input readOnly value={check.walletUrl} onFocus={(e) => e.target.select()} className="mt-2 w-full rounded border border-slate-200 px-2 py-1 text-xs text-slate-500" />
            <button onClick={() => start(active)} className="mt-3 text-sm text-indigo-700 underline">New check</button>
          </div>
          <Result status={status} />
        </div>
      )}
    </div>
  );
}

type Blocked = { active: number; total: number; recent: { at: string; source: string; verifierId: string; seconds: number }[] };
type InstanceInfo = { name: string; port: number; alive: boolean; lastSyncedAt: number | null; served?: number; failures?: number; uptimeSeconds?: number };

// One card per verifier instance behind the front door, each with its own Kill and Restart button.
function InstancePanel() {
  const [info, setInfo] = useState<{ instances: InstanceInfo[]; now: number; blocked: Blocked; limits: { failMax: number; failWindowSeconds: number; blockSeconds: number } } | null>(null);

  const refresh = () => fetch(URLS.verifierApi + '/proxy/status').then((r) => r.json()).then(setInfo).catch(() => setInfo(null));
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, []);

  // name is an instance number, or "all".
  const act = (action: 'kill' | 'restart', name: string) => fetch(`${URLS.verifierApi}/proxy/${action}/${name}`, { method: 'POST' }).then(refresh);

  if (!info) return <div className="mb-6 rounded-xl bg-rose-50 p-3 text-sm text-rose-700">Front door (port 4000) is not reachable. Is "npm run dev" running?</div>;
  const button = 'rounded px-2 py-1 text-xs text-white disabled:opacity-30';
  return (
    <div className="mb-6 rounded-xl bg-white p-3 text-sm shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs text-slate-500">Verifier instances behind the front door (port 4000) · {info.instances.filter((i) => i.alive).length} of {info.instances.length} alive</span>
        <span className="flex gap-2">
          <button onClick={() => act('kill', 'all')} className={button + ' bg-rose-600'}>Kill all</button>
          <button onClick={() => act('restart', 'all')} className={button + ' bg-emerald-600'}>Restart all</button>
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {info.instances.map((i) => (
          <div key={i.name} className={`rounded-lg border px-3 py-2 ${i.alive ? 'border-emerald-300 bg-emerald-50' : 'border-rose-300 bg-rose-50'}`}>
            <div className="font-semibold">Instance {i.name} <span className="font-normal text-slate-500">:{i.port}</span> · {i.alive ? 'alive' : 'dead'}</div>
            <div className="mb-2 text-xs text-slate-500">
              {i.lastSyncedAt ? `last synced ${Math.max(0, Math.round((info.now - i.lastSyncedAt) / 1000))} seconds ago` : 'not synced yet'}
              {i.alive && <div>served {i.served ?? 0} · failures {i.failures ?? 0} · up {i.uptimeSeconds ?? 0}s</div>}
            </div>
            <div className="flex gap-2">
              <button disabled={!i.alive} onClick={() => act('kill', i.name)} className={button + ' bg-rose-600'}>Kill</button>
              <button disabled={i.alive} onClick={() => act('restart', i.name)} className={button + ' bg-emerald-600'}>Restart</button>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
        <b>Rate limiting:</b> {info.limits.failMax} failed attempts in {info.limits.failWindowSeconds}s blocks a source for {info.limits.blockSeconds}s.{' '}
        <span className={info.blocked.active > 0 ? 'font-semibold text-rose-700' : ''}>Blocked sources now: {info.blocked.active}</span> · blocks since start: {info.blocked.total}
        {info.blocked.recent.map((event, n) => (
          <div key={n} className="font-mono text-slate-500">
            {new Date(event.at).toLocaleTimeString()} · source {event.source} · {event.verifierId} · {event.seconds}s
          </div>
        ))}
      </div>
    </div>
  );
}

// "Run load test": 50 synthetic requests through the front door, as the clearly-labelled load-test verifier.
// Each is created once and polled once. The bars show which instance served each call.
function LoadTest() {
  const [stats, setStats] = useState<LoadTestStats | null>(null);
  const run = () => runLoadTest((path, init) => fetch(URLS.verifierApi + path, init), setStats);
  const busiest = stats ? Math.max(1, ...Object.values(stats.perInstance)) : 1;
  return (
    <div className="mb-6 rounded-xl bg-white p-3 text-sm shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-slate-500">Load test: 50 synthetic requests (create + poll = 100 calls) as "Load test (synthetic)". Not real verifications; deleted afterwards.</span>
        <button onClick={run} disabled={stats?.running} className="shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-white disabled:opacity-40">{stats?.running ? 'Running…' : 'Run load test'}</button>
      </div>
      {stats && (
        <div className="mt-3 space-y-1">
          {Object.entries(stats.perInstance).sort().map(([name, count]) => (
            <div key={name} className="flex items-center gap-2 text-xs">
              <span className="w-20 text-slate-600">{name}</span>
              <div className="h-4 flex-1 rounded bg-slate-100"><div className="h-4 rounded bg-indigo-500" style={{ width: `${(count / busiest) * 100}%` }} /></div>
              <span className="w-8 text-right font-mono">{count}</span>
            </div>
          ))}
          <div className="pt-1 text-xs text-slate-600">
            {stats.calls} of {stats.totalCalls} calls · average {stats.averageMs} ms · slowest {stats.slowestMs} ms ·{' '}
            <span className={stats.failures > 0 ? 'font-semibold text-rose-700' : 'text-emerald-700'}>{stats.failures} failures</span>
            {!stats.running && ' · finished, synthetic requests deleted'}
          </div>
        </div>
      )}
    </div>
  );
}

// Small badge: which instance answered (from the front door's X-Served-By header).
function ServedBy({ status }: { status: Status }) {
  if (!status.servedBy) return null;
  return <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-white">Served by {status.servedBy}</span>;
}

function Result({ status }: { status: Status | null }) {
  if (!status || status.state === 'pending') {
    return <div className="flex items-center justify-center rounded-xl bg-white p-5 text-slate-500 shadow"><span className="animate-pulse">Waiting for the holder to approve…</span></div>;
  }
  if (status.state === 'verified') {
    const claims = status.result?.claims ?? {};
    return (
      <div className="rounded-xl border-2 border-emerald-500 bg-emerald-50 p-5 shadow">
        <div className="flex items-center justify-between"><div className="text-3xl font-bold text-emerald-700">✓ Verified</div><ServedBy status={status} /></div>
        <div className="mb-3 text-xs text-emerald-800">Signed by {status.result?.issuer}. This is everything we received:</div>
        {Object.entries(claims).map(([name, value]) => (
          <div key={name} className="flex items-center justify-between gap-3 border-t border-emerald-200 py-2 text-sm">
            <span className="text-slate-600">{CLAIM_LABELS[name] ?? name}</span>
            {name === 'photo'
              ? <img src={String(value)} alt="" className="h-12 w-12 rounded" />
              : <span className="font-semibold">{value === true ? 'Yes' : value === false ? 'No' : String(value)}</span>}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="rounded-xl border-2 border-rose-500 bg-rose-50 p-5 shadow">
      <div className="float-right"><ServedBy status={status} /></div>
      <div className="text-3xl font-bold text-rose-700">✗ {status.state === 'expired' ? 'Expired' : 'Denied'}</div>
      <div className="mt-2 text-sm text-rose-800">{status.result?.code ?? 'request_expired'}</div>
      <div className="text-xs text-rose-700">{status.result?.message}</div>
    </div>
  );
}
