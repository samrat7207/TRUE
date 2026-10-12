// Registers: a person's saved checks. Each one is set up ONCE and pinned to ONE institution and ONE ID type.
// The QR button makes a FRESH request every time and shows the result live.
import { useEffect, useState } from 'react';
import { CLAIM_LABELS, SENSITIVE_CLAIMS, TEMPLATES, URLS, templateLabel } from '@true/shared';
import type { IssuerInfo } from '@true/registry';
import { Badge, BottomTabs, Card, Field, PillButton, QrPanel, Screen, StepList, TopBar, go } from '../ui.tsx';
import { getSession } from '../session.ts';
import { STEP_LABELS, registry } from '../wallet.ts';

export type Register = { id: string; name: string; purpose: string; issuerId: string; issuerName: string; type: string; fields: string[] };

// Call the verifier front door as the logged-in person. Returns the response so callers can read headers too.
// Gives up after 10 seconds instead of waiting for ever.
export async function verifierCall(path: string, body?: unknown): Promise<Response> {
  return fetch(URLS.verifierApi + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${getSession()?.token ?? ''}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

// The same call, turned into a result a screen can always show: the data, or an error with its status code.
// It never throws and never hangs: no answer, a timeout and an unreadable answer all become an error.
export type CallResult<T> = { ok: true; data: T; servedBy: string | null } | { ok: false; status: number | null; message: string };
export async function verifierJson<T>(path: string, body?: unknown): Promise<CallResult<T>> {
  let response: Response;
  try {
    response = await verifierCall(path, body);
  } catch (e) {
    const timedOut = e instanceof DOMException && e.name === 'TimeoutError';
    return { ok: false, status: null, message: timedOut ? 'No answer from the verifier after 10 seconds.' : 'The verifier is not reachable.' };
  }
  const data = await response.json().catch(() => null);
  if (response.ok && data) return { ok: true, data, servedBy: response.headers.get('X-Served-By') };
  const fallback = response.status === 404
    ? 'The verifier servers do not have this feature. They are probably running older code than the app: stop and restart "npm run dev".'
    : 'The verifier sent an answer the app could not read.';
  return { ok: false, status: response.status, message: data?.error?.message ?? fallback };
}

function useRegisters() {
  const [registers, setRegisters] = useState<Register[] | null>(null);
  const [error, setError] = useState('');
  const reload = async () => {
    const result = await verifierJson<{ registers: Register[] }>('/v1/registers');
    if (result.ok) { setRegisters(result.data.registers); setError(''); } else setError(`${result.message}${result.status ? ` (status ${result.status})` : ''}`);
  };
  useEffect(() => { reload(); }, []);
  return { registers, error, reload };
}

// ---------- list ----------

export function Registers() {
  const { registers, error } = useRegisters();
  return (
    <Screen tabs={<BottomTabs active="/registers" />}>
      <h1 className="text-title font-bold leading-tight">Registers</h1>
      <p className="mt-2 mb-5 text-muted">Your own checks. Each accepts one institution's one ID type and asks only for the fields you chose.</p>
      {error && <Card tone="bad" className="mb-3"><span className="text-small text-bad">{error}</span></Card>}
      <div className="space-y-3">
        {registers?.length === 0 && <Card><span className="text-small text-muted">No registers yet.</span></Card>}
        {registers?.map((register) => (
          <Card key={register.id}>
            <div className="flex items-start gap-3">
              {/* Tap the register to open its visitor list. */}
              <button onClick={() => go(`/register-visitors?id=${register.id}`)} className="min-w-0 flex-1 text-left">
                <div className="font-semibold">{register.name} <span className="font-normal text-muted">›</span></div>
                <div className="text-small text-muted">{register.purpose}</div>
                <div className="mt-1 text-small">{templateLabel(register.type)} from {register.issuerName}</div>
                <div className="text-tiny text-muted">Asks for: {register.fields.map((f) => CLAIM_LABELS[f] ?? f).join(', ')}</div>
              </button>
              {/* QR icon: opens the check screen, which makes a fresh request. */}
              <button onClick={() => go(`/register?id=${register.id}`)} aria-label="Show QR" className="flex h-12 w-12 shrink-0 items-center justify-center rounded-row bg-ink text-white">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z" /></svg>
              </button>
            </div>
          </Card>
        ))}
      </div>
      <div className="mt-5"><PillButton onClick={() => go('/register-new')}>+ New register</PillButton></div>
    </Screen>
  );
}

// ---------- create (one-time set-up) ----------

export function NewRegister() {
  const [institutions, setInstitutions] = useState<IssuerInfo[] | null>(null);
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [issuerId, setIssuerId] = useState('');
  const [type, setType] = useState('StudentID');
  const [fields, setFields] = useState<string[]>([]);
  const [error, setError] = useState('');

  // The institutions to choose from come straight from the registry on the chain.
  useEffect(() => { registry.listIssuers().then((list) => { setInstitutions(list); setIssuerId(list[0]?.id ?? ''); }).catch(() => setError('The registry is not reachable')); }, []);
  const toggle = (field: string) => setFields(fields.includes(field) ? fields.filter((f) => f !== field) : [...fields, field]);

  async function create() {
    setError('');
    const issuerName = institutions?.find((i) => i.id === issuerId)?.name ?? '';
    const result = await verifierJson('/v1/registers', { name, purpose, issuerId, issuerName, type, fields });
    if (!result.ok) return setError(`${result.message}${result.status ? ` (status ${result.status})` : ''}`);
    go('/registers');
  }

  const input = 'mt-1 w-full rounded-row border border-line bg-surface px-3 py-3 font-normal';
  return (
    <Screen>
      <TopBar back="/registers" title="New register" />
      <p className="mb-4 text-small text-muted">Set up once. The institution, ID type and fields cannot be changed afterwards; delete and create again instead.</p>
      <label className="block text-small font-semibold">Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Hostel gate" className={input} /></label>
      <label className="mt-3 block text-small font-semibold">Purpose (shown to the person)<input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. Entry to the hostel" className={input} /></label>
      <label className="mt-3 block text-small font-semibold">Accept IDs only from
        <select value={issuerId} onChange={(e) => setIssuerId(e.target.value)} className={input}>
          {institutions?.map((i) => <option key={i.id} value={i.id}>{i.name}{i.verified ? '' : ' (unverified)'}</option>)}
        </select>
      </label>
      <label className="mt-3 block text-small font-semibold">ID type
        <select value={type} onChange={(e) => { setType(e.target.value); setFields([]); }} className={input}>
          {Object.entries(TEMPLATES).map(([value, t]) => <option key={value} value={value}>{t.label}</option>)}
        </select>
      </label>
      <div className="mt-4 mb-1 text-small font-semibold">Fields to ask for (only from a {templateLabel(type)})</div>
      <Card>
        {TEMPLATES[type].fields.map((field) => (
          <label key={field} className="flex items-center gap-3 border-b border-line py-2 last:border-0">
            <input type="checkbox" checked={fields.includes(field)} onChange={() => toggle(field)} className="h-5 w-5" />
            <span className="flex-1">{CLAIM_LABELS[field] ?? field}</span>
            {SENSITIVE_CLAIMS.includes(field) && <Badge tone="warn">Sensitive</Badge>}
          </label>
        ))}
      </Card>
      <p className="mt-2 text-tiny text-muted">Ask for as little as you need. People are warned when a register asks for sensitive fields.</p>
      {error && <Card tone="bad" className="mt-3"><span className="text-small text-bad">{error}</span></Card>}
      <div className="mt-4"><PillButton onClick={create} disabled={name.trim().length < 2 || purpose.trim().length < 2 || !issuerId || fields.length === 0}>Create register</PillButton></div>
    </Screen>
  );
}

// ---------- check: fresh QR, live status ----------

type Check = { requestId: string; walletUrl: string; expiresAt: string };
type Status = {
  state: 'pending' | 'verified' | 'denied' | 'expired';
  result: { claims?: Record<string, unknown>; code?: string; message?: string; steps?: { name: string; status: 'pass' | 'fail' | 'skipped' }[] } | null;
  servedBy?: string | null;
};

export function RegisterCheck({ id }: { id: string }) {
  const { registers } = useRegisters();
  const register = registers?.find((r) => r.id === id);
  const [check, setCheck] = useState<Check | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // A FRESH request every time: new nonce, valid for 2 minutes, asking for the register's stored fields.
  async function fresh() {
    setStatus(null); setError(''); setCopied(false);
    const result = await verifierJson<Check>(`/v1/registers/${id}/requests`, {});
    if (!result.ok) { setCheck(null); return setError(`${result.message}${result.status ? ` (status ${result.status})` : ''}`); }
    setCheck(result.data);
  }
  useEffect(() => { fresh(); }, [id]);

  // Live status: ask once a second until the request is answered or runs out.
  useEffect(() => {
    if (!check) return;
    let tries = 0;
    const timer = setInterval(async () => {
      const response = await verifierCall(`/v1/requests/${check.requestId}`).catch(() => null);
      if (!response?.ok) return;
      const next: Status = { ...(await response.json()), servedBy: response.headers.get('X-Served-By') };
      // Disclosed fields are held only by the instance that did the check: keep an answer that has them,
      // and ask a few more times so the round-robin reaches that instance.
      setStatus((previous) => (previous?.result?.claims && !next.result?.claims ? previous : next));
      if (next.state !== 'pending' && (next.state !== 'verified' || next.result?.claims || ++tries > 6)) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [check]);

  const remove = async () => { await verifierCall(`/v1/registers/${id}/delete`, {}); go('/registers'); };

  if (registers && !register) return <Screen><TopBar back="/registers" /><Card>This register no longer exists.</Card></Screen>;
  const state = status?.state ?? 'pending';
  return (
    <Screen>
      <TopBar back="/registers" title={register?.name ?? ''} />
      {register && <p className="mb-4 text-center text-small text-muted">{templateLabel(register.type)} from {register.issuerName} · {register.fields.map((f) => CLAIM_LABELS[f] ?? f).join(', ')}</p>}
      {error && <Card tone="bad" className="mb-3"><span className="text-small text-bad">{error}</span></Card>}

      {check && state === 'pending' && (
        <>
          <QrPanel value={check.walletUrl} caption={`Waiting for a scan · valid until ${new Date(check.expiresAt).toLocaleTimeString()}`} />
          <div className="mt-3"><PillButton kind="secondary" onClick={() => navigator.clipboard.writeText(check.walletUrl).then(() => setCopied(true))}>{copied ? 'Link copied' : 'Copy link'}</PillButton></div>
        </>
      )}

      {status && state !== 'pending' && (
        <Card tone={state === 'verified' ? 'ok' : 'bad'} className="mb-3">
          <div className="flex items-center justify-between">
            <span className={`text-2xl font-bold ${state === 'verified' ? 'text-ok' : 'text-bad'}`}>{state === 'verified' ? '✓ Verified' : state === 'expired' ? 'Expired' : '✕ Denied'}</span>
            {status.servedBy && <Badge>Served by {status.servedBy}</Badge>}
          </div>
          {state === 'denied' && <p className="mt-1 text-small">{status.result?.code}: {status.result?.message}</p>}
          {state === 'verified' && (status.result?.claims
            ? Object.entries(status.result.claims).map(([name, value]) => <Field key={name} label={CLAIM_LABELS[name] ?? name}>{String(value)}</Field>)
            : <p className="mt-1 text-small">Verified. The instance that did the check holds the fields; fetching them…</p>)}
        </Card>
      )}
      {status?.result?.steps && (
        <Card className="mb-3">
          <div className="mb-3 font-semibold">Verification steps</div>
          <StepList steps={status.result.steps.map((step) => ({ label: STEP_LABELS[step.name] ?? step.name, status: step.status }))} />
        </Card>
      )}

      <div className="mt-3 space-y-3">
        <PillButton onClick={fresh}>{state === 'pending' ? 'New QR' : 'Check another person'}</PillButton>
        {confirmDelete
          ? <PillButton kind="danger" onClick={remove}>Yes, delete this register</PillButton>
          : <PillButton kind="secondary" onClick={() => setConfirmDelete(true)}>Delete register</PillButton>}
      </div>
    </Screen>
  );
}
