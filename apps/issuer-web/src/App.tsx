// Issuer admin screen: the student register, issuing, revoking, and the issuer's signing keys.
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { BRAND, ISSUER_NAME, URLS } from '@true/shared';

type Student = { id: number; name: string; pnr: string; class: string; section: string; branch: string; photo: string; status: string; revoked_reason: string | null; status_list_index: number | null };
type Offer = { studentName: string; code: string; expiresAt: string; offerUrl: string; qr: string };
type Stats = { issued: number; active: number; revoked: number };
type Key = { kid: string; state: 'Active' | 'Retired' | 'Compromised'; createdAt: string };

// Reason codes only (no free text), so nothing personal can end up in the record.
const REASONS = ['left_institution', 'graduated', 'lost_device', 'issued_in_error', 'misconduct'];
const REINSTATE_REASONS = ['revoked_in_error', 're_enrolled', 'device_replaced', 'appeal_accepted'];

// The staff session token from the PIN sign-in. The issuer API checks it, and the staff member's role, on every call.
let token = '';
const headers = () => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });

// POST JSON and return both the HTTP status and the parsed body.
async function post(path: string, body: unknown = {}) {
  const response = await fetch(URLS.issuerApi + path, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  return { ok: response.ok, body: await response.json() };
}
const get = (path: string) => fetch(URLS.issuerApi + path, { headers: headers() }).then((r) => r.json());

// Staff PIN sign-in bar. Sign in as the admin to use every button on this page; other roles are limited by the server.
function SignIn({ onSignedIn }: { onSignedIn: (who: string) => void }) {
  const [staff, setStaff] = useState<{ id: string; name: string; role: string }[]>([]);
  const [staffId, setStaffId] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { fetch(URLS.issuerApi + '/v1/staff/directory').then((r) => r.json()).then((b) => { setStaff(b.staff); setStaffId(b.staff[0]?.id ?? ''); }); }, []);
  async function signIn() {
    const response = await fetch(URLS.issuerApi + '/v1/staff/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ staffId, pin }) });
    const body = await response.json();
    if (!response.ok) return setError(body.error.message);
    token = body.token;
    onSignedIn(`${body.staff.name} (${body.staff.role})`);
  }
  return (
    <div className="mx-auto mt-24 max-w-sm space-y-3 rounded-xl bg-white p-6 shadow">
      <h1 className="text-lg font-bold">Staff sign-in</h1>
      <select value={staffId} onChange={(e) => setStaffId(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2">
        {staff.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.role}</option>)}
      </select>
      <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} placeholder="PIN" className="w-full rounded-lg border border-slate-300 px-3 py-2" />
      {error && <p className="text-sm text-rose-700">{error}</p>}
      <button onClick={signIn} className="w-full rounded-lg bg-indigo-600 py-2 text-white">Sign in</button>
      <p className="text-xs text-slate-500">Demo PINs are in the .env file (STAFF_PIN_ADMIN and so on).</p>
    </div>
  );
}

export default function App() {
  const [who, setWho] = useState('');
  return who ? <Console who={who} /> : <SignIn onSignedIn={setWho} />;
}

function Console({ who }: { who: string }) {
  const [students, setStudents] = useState<Student[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [keys, setKeys] = useState<Key[]>([]);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [message, setMessage] = useState('');
  const [reasons, setReasons] = useState<Record<number, string>>({});
  const [reinstateReasons, setReinstateReasons] = useState<Record<number, string>>({}); // empty until the admin picks one

  const reload = () => {
    get('/v1/students').then((b) => setStudents(b.students));
    get('/v1/stats').then(setStats);
    get('/v1/keys').then((b) => setKeys(b.keys));
  };
  useEffect(reload, []);

  // Ask the API for a one-time claim code and draw it as a QR code.
  async function issue(studentId: number, studentName: string) {
    setMessage('');
    setOffer(null);
    const { ok, body } = await post('/v1/claim-codes', { studentId });
    if (!ok) return setMessage(`Refused: ${body.error.code}: ${body.error.message}`);
    setOffer({ studentName, ...body, qr: await QRCode.toDataURL(body.offerUrl, { width: 220, margin: 1 }) });
  }

  // Revoke: flips the student's bit in the revocation list and anchors the new fingerprint on the chain.
  async function revoke(student: Student) {
    const { ok, body } = await post(`/v1/students/${student.id}/revoke`, { reason: reasons[student.id] ?? REASONS[0] });
    setMessage(ok
      ? `Revoked ${student.name}. ${body.anchored ? 'New revocation fingerprint anchored on the chain.' : 'No credential had been issued, so the list did not change.'} Verifiers pick it up at their next scheduled refresh (a few seconds).`
      : `Refused: ${body.error.code}: ${body.error.message}`);
    reload();
  }

  // Give the credential back: the student becomes active again, then we open a new claim code for them.
  // The old credential stays revoked; the student collects a new one.
  async function reinstate(student: Student) {
    const { ok, body } = await post(`/v1/students/${student.id}/reinstate`, { reason: reinstateReasons[student.id] });
    if (!ok) return setMessage(`Refused: ${body.error.code}: ${body.error.message}`);
    await issue(student.id, student.name);
    setMessage(`${student.name} reinstated (${body.reason}). NEXT STEP: the student must collect a NEW credential with the claim code on the right ("Open in wallet"). The old card in their wallet stays revoked and will keep being refused.`);
    reload();
  }

  async function keyAction(path: string, done: string) {
    const { ok, body } = await post(path);
    setMessage(ok ? `${done} Active key is now ${body.activeKeyId}.` : `Refused: ${body.error.code}: ${body.error.message}`);
    reload();
  }

  const keyColour = { Active: 'bg-emerald-100 text-emerald-700', Retired: 'bg-slate-200 text-slate-600', Compromised: 'bg-rose-100 text-rose-700' };

  return (
    <div className="mx-auto max-w-5xl p-6">
      <header className="mb-6 flex items-end justify-between border-b border-slate-300 pb-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500">{BRAND.name} · Issuer console</div>
          <h1 className="text-2xl font-bold">{ISSUER_NAME}</h1>
        </div>
        <div className="text-right text-xs text-slate-500">{BRAND.fullForm}<br />Signed in: {who}<br />All student data on this page is fake demo data.</div>
      </header>

      {stats && (
        <div className="mb-6 grid grid-cols-3 gap-3 text-center">
          {([['Credentials issued', stats.issued, 'text-slate-900'], ['Active', stats.active, 'text-emerald-700'], ['Revoked', stats.revoked, 'text-rose-700']] as const).map(([label, value, colour]) => (
            <div key={label} className="rounded-xl bg-white p-3 shadow-sm">
              <div className={`text-2xl font-bold ${colour}`}>{value}</div>
              <div className="text-xs uppercase text-slate-500">{label}</div>
            </div>
          ))}
        </div>
      )}
      {message && <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{message}</p>}

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="lg:col-span-2">
          <h2 className="mb-2 text-sm font-semibold uppercase text-slate-500">Student register (issuer database)</h2>
          <div className="overflow-hidden rounded-xl bg-white shadow">
            {students.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3 last:border-0">
                <img src={s.photo} alt="" className="h-10 w-10 rounded" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{s.name}</div>
                  <div className="text-xs text-slate-500">{s.pnr} · {s.class}-{s.section} · {s.branch}{s.status_list_index !== null && ` · list position ${s.status_list_index}`}</div>
                  {s.status === 'active' && s.status_list_index === null && <div className="text-xs text-amber-700">No credential collected yet: click "Issue credential" and have the student claim it.</div>}
                </div>
                <span className={`rounded-full px-2 py-0.5 text-xs ${s.status === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
                  {s.status}{s.revoked_reason && `: ${s.revoked_reason}`}
                </span>
                {s.status === 'revoked' && (
                  <>
                    <select value={reinstateReasons[s.id] ?? ''} onChange={(e) => setReinstateReasons({ ...reinstateReasons, [s.id]: e.target.value })} className="rounded-lg border border-slate-300 px-1 py-1.5 text-xs">
                      <option value="">Reason to give it back…</option>
                      {REINSTATE_REASONS.map((r) => <option key={r}>{r}</option>)}
                    </select>
                    <button disabled={!reinstateReasons[s.id]} onClick={() => reinstate(s)} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm text-white disabled:opacity-30">Give back</button>
                  </>
                )}
                {s.status === 'active' && (
                  <>
                    <button onClick={() => issue(s.id, s.name)} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm text-white">Issue credential</button>
                    <select value={reasons[s.id] ?? REASONS[0]} onChange={(e) => setReasons({ ...reasons, [s.id]: e.target.value })} className="rounded-lg border border-slate-300 px-1 py-1.5 text-xs">
                      {REASONS.map((r) => <option key={r}>{r}</option>)}
                    </select>
                    <button onClick={() => revoke(s)} className="rounded-lg bg-rose-600 px-3 py-1.5 text-sm text-white">Revoke</button>
                  </>
                )}
              </div>
            ))}
          </div>

          <h2 className="mt-6 mb-2 text-sm font-semibold uppercase text-slate-500">Demo: who does NOT get a credential</h2>
          <div className="rounded-xl bg-white p-4 text-sm shadow">
            <button onClick={() => issue(9999, 'Unknown person')} className="rounded-lg border border-slate-300 px-3 py-1.5">Try to issue to someone not in the database (id 9999)</button>
            <p className="mt-2 text-xs text-slate-500">To show a reused code: claim a code in the wallet, then try the same code again.</p>
          </div>
        </section>

        <aside className="space-y-6">
          <div>
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
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold uppercase text-slate-500">Signing keys (public halves are on the chain)</h2>
            <div className="space-y-2 rounded-xl bg-white p-4 text-sm shadow">
              {keys.map((k) => (
                <div key={k.kid} className="flex items-center justify-between gap-2">
                  <span className="font-mono">{k.kid}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${keyColour[k.state]}`}>{k.state}</span>
                  <button disabled={k.state === 'Compromised'} onClick={() => keyAction(`/v1/keys/${k.kid}/compromise`, `${k.kid} marked Compromised: verifiers now reject everything it signed.`)} className="rounded bg-rose-600 px-2 py-1 text-xs text-white disabled:opacity-30">Mark compromised</button>
                </div>
              ))}
              <button onClick={() => keyAction('/v1/keys/rotate', 'Key rotated; the old key is Retired and its credentials stay valid.')} className="mt-2 w-full rounded-lg bg-slate-800 py-2 text-white">Rotate key</button>
              <p className="text-xs text-slate-500">Retired = replaced normally. Compromised = leaked: students must be re-issued.</p>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
