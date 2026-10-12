// Issuer admin screen: the student register, and the "Issue credential" button.
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { BRAND, ISSUER_NAME, URLS } from '@true/shared';

type Student = { id: number; name: string; pnr: string; class: string; section: string; branch: string; photo: string; status: string; status_list_index: number | null };
type Offer = { studentName: string; code: string; expiresAt: string; offerUrl: string; qr: string };

// POST JSON and return both the HTTP status and the parsed body.
async function post(path: string, body: unknown) {
  const response = await fetch(URLS.issuerApi + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: response.ok, body: await response.json() };
}

export default function App() {
  const [students, setStudents] = useState<Student[]>([]);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [message, setMessage] = useState('');

  const reload = () => fetch(URLS.issuerApi + '/v1/students').then((r) => r.json()).then((b) => setStudents(b.students));
  useEffect(() => { reload(); }, []);

  // Ask the API for a one-time claim code and draw it as a QR code.
  async function issue(studentId: number, studentName: string) {
    setMessage('');
    setOffer(null);
    const { ok, body } = await post('/v1/claim-codes', { studentId });
    if (!ok) return setMessage(`Refused: ${body.error.code}: ${body.error.message}`);
    setOffer({ studentName, ...body, qr: await QRCode.toDataURL(body.offerUrl, { width: 220, margin: 1 }) });
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <header className="mb-6 flex items-end justify-between border-b border-slate-300 pb-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500">{BRAND.name} · Issuer console</div>
          <h1 className="text-2xl font-bold">{ISSUER_NAME}</h1>
        </div>
        <div className="text-right text-xs text-slate-500">{BRAND.fullForm}<br />All student data on this page is fake demo data.</div>
      </header>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="lg:col-span-2">
          <h2 className="mb-2 text-sm font-semibold uppercase text-slate-500">Student register (issuer database)</h2>
          <div className="overflow-hidden rounded-xl bg-white shadow">
            {students.map((s) => (
              <div key={s.id} className="flex items-center gap-3 border-b border-slate-100 px-4 py-3 last:border-0">
                <img src={s.photo} alt="" className="h-10 w-10 rounded" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{s.name}</div>
                  <div className="text-xs text-slate-500">{s.pnr} · {s.class}-{s.section} · {s.branch}</div>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-xs ${s.status === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>{s.status}</span>
                <button onClick={() => issue(s.id, s.name)} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm text-white">Issue credential</button>
              </div>
            ))}
          </div>

          <h2 className="mt-6 mb-2 text-sm font-semibold uppercase text-slate-500">Demo: who does NOT get a credential</h2>
          <div className="rounded-xl bg-white p-4 text-sm shadow">
            <button onClick={() => issue(9999, 'Unknown person')} className="rounded-lg border border-slate-300 px-3 py-1.5">Try to issue to someone not in the database (id 9999)</button>
            <p className="mt-2 text-xs text-slate-500">To show a reused code: claim a code in the wallet, then try the same code again.</p>
          </div>
          {message && <p className="mt-3 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{message}</p>}
        </section>

        <aside>
          <h2 className="mb-2 text-sm font-semibold uppercase text-slate-500">Credential offer</h2>
          {!offer && <p className="rounded-xl bg-white p-4 text-sm text-slate-500 shadow">Click "Issue credential" to create a one-time claim code.</p>}
          {offer && (
            <div className="space-y-3 rounded-xl bg-white p-4 text-center shadow">
              <div className="text-sm">For <b>{offer.studentName}</b></div>
              <img src={offer.qr} alt="QR offer" className="mx-auto" />
              <div className="font-mono text-2xl tracking-widest">{offer.code}</div>
              <div className="text-xs text-slate-500">One-time use · expires {new Date(offer.expiresAt).toLocaleTimeString()}</div>
              <a href={offer.offerUrl} target="true-wallet" className="block rounded-lg bg-slate-800 py-2 text-sm text-white">Open in wallet (same laptop)</a>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
