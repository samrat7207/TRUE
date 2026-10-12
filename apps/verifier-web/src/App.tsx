// Verifier screen: pick who you are, show a QR, and watch the result arrive live.
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { BRAND, CLAIM_LABELS, URLS } from '@true/shared';

type Verifier = { id: string; name: string; purpose: string; claims: string[] };
type Check = { requestId: string; walletUrl: string; qr: string };
type Status = { state: 'pending' | 'verified' | 'denied' | 'expired'; result: { claims?: Record<string, unknown>; issuer?: string; code?: string; message?: string } | null };

export default function App() {
  const [verifiers, setVerifiers] = useState<Verifier[]>([]);
  const [active, setActive] = useState<Verifier | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => { fetch(URLS.verifierApi + '/v1/verifiers').then((r) => r.json()).then((b) => setVerifiers(b.verifiers)); }, []);

  // Create a request (fresh nonce on the server) and draw the wallet link as a QR code.
  async function start(verifier: Verifier) {
    setActive(verifier);
    setStatus(null);
    const response = await fetch(URLS.verifierApi + '/v1/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verifierId: verifier.id }) });
    const body = await response.json();
    setCheck({ requestId: body.requestId, walletUrl: body.walletUrl, qr: await QRCode.toDataURL(body.walletUrl, { width: 260, margin: 1 }) });
  }

  // Live update: ask the API once a second until the request is no longer pending.
  useEffect(() => {
    if (!check) return;
    const timer = setInterval(async () => {
      const body: Status = await fetch(`${URLS.verifierApi}/v1/requests/${check.requestId}`).then((r) => r.json());
      setStatus(body);
      if (body.state !== 'pending') clearInterval(timer);
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
            <div className="font-semibold">{v.name}</div>
            <div className="text-xs text-slate-500">{v.purpose}</div>
            <div className="mt-2 text-xs text-indigo-700">Asks for: {v.claims.map((c) => CLAIM_LABELS[c]).join(', ')}</div>
          </button>
        ))}
      </div>

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

function Result({ status }: { status: Status | null }) {
  if (!status || status.state === 'pending') {
    return <div className="flex items-center justify-center rounded-xl bg-white p-5 text-slate-500 shadow"><span className="animate-pulse">Waiting for the holder to approve…</span></div>;
  }
  if (status.state === 'verified') {
    const claims = status.result?.claims ?? {};
    return (
      <div className="rounded-xl border-2 border-emerald-500 bg-emerald-50 p-5 shadow">
        <div className="text-3xl font-bold text-emerald-700">✓ Verified</div>
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
      <div className="text-3xl font-bold text-rose-700">✗ {status.state === 'expired' ? 'Expired' : 'Denied'}</div>
      <div className="mt-2 text-sm text-rose-800">{status.result?.code ?? 'request_expired'}</div>
      <div className="text-xs text-rose-700">{status.result?.message}</div>
    </div>
  );
}
