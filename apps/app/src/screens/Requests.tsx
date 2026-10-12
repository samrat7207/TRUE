// Requests tab: ask an institute for a credential, and watch the answer arrive.
import { useEffect, useState } from 'react';
import { CREDENTIAL_TYPES, ISSUER_NAME } from '@true/shared';
import { getMyRequests, refreshCredentialRequests, submitCredentialRequest, type MyRequest } from '@true/wallet-core';
import { Badge, BottomTabs, Card, PillButton, Screen } from '../ui.tsx';
import { browserFetch, issuerApiAddress } from '../wallet.ts';

const TONE = { pending: 'warn', approved: 'ok', rejected: 'bad' } as const;
const LABEL = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected' };

// Ask the issuer about pending requests; an approved one is collected into the wallet automatically.
export const checkMyRequests = async () => refreshCredentialRequests({ issuerApi: await issuerApiAddress(), fetch: browserFetch });

export function Requests() {
  const [requests, setRequests] = useState<MyRequest[]>([]);
  const [type, setType] = useState('StudentCredential');
  const [pnr, setPnr] = useState('');
  const [dob, setDob] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Show what is stored, then keep checking every 3 seconds while this tab is open.
  useEffect(() => {
    getMyRequests().then(setRequests);
    const timer = setInterval(() => checkMyRequests().then(setRequests).catch(() => {}), 3000);
    return () => clearInterval(timer);
  }, []);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await submitCredentialRequest({ type, pnr, dob, issuerApi: await issuerApiAddress(), fetch: browserFetch });
      setPnr('');
      setDob('');
      setRequests(await getMyRequests());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the request');
    }
    setBusy(false);
  }

  const input = 'mt-1 w-full rounded-row border border-line bg-surface px-3 py-3 font-normal';
  return (
    <Screen tabs={<BottomTabs active="/requests" />}>
      <h1 className="text-title font-bold leading-tight">Requests</h1>
      <p className="mt-2 mb-5 text-muted">Ask {ISSUER_NAME} for a credential. Staff there approve or reject it.</p>

      <Card className="mb-4">
        <label className="block text-small font-semibold">Credential type
          <select value={type} onChange={(e) => setType(e.target.value)} className={input}>
            {Object.entries(CREDENTIAL_TYPES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="mt-3 block text-small font-semibold">PNR (student number)
          <input value={pnr} onChange={(e) => setPnr(e.target.value)} placeholder="e.g. AIT2023002" className={input + ' font-mono uppercase'} />
        </label>
        <label className="mt-3 block text-small font-semibold">Date of birth
          <input type="date" value={dob} onChange={(e) => setDob(e.target.value)} className={input} />
        </label>
        <div className="mt-4"><PillButton onClick={submit} disabled={busy || pnr.trim().length < 3 || !dob}>{busy ? 'Sending…' : 'Send request'}</PillButton></div>
        {error && <p className="mt-2 text-small text-bad">{error}</p>}
      </Card>

      <Card tone="warn" className="mb-5">
        <p className="text-small">
          <b>Demo limit:</b> this is not real identity proofing. Anyone who knows a PNR and a date of birth could send this form.
          A real issuer would check the person before approving. Use the fake demo students only.
        </p>
      </Card>

      <h2 className="mb-2 text-lg font-semibold">Your requests</h2>
      <div className="space-y-2">
        {requests.length === 0 && <Card><span className="text-small text-muted">You have not asked for anything yet.</span></Card>}
        {requests.map((request) => (
          <Card key={request.id}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-semibold">{CREDENTIAL_TYPES[request.type]}</div>
                <div className="text-small text-muted">{ISSUER_NAME} · {request.pnr}</div>
                <div className="text-tiny text-muted">{new Date(request.createdAt).toLocaleString()}</div>
                {request.note && <div className="mt-1 text-small">{request.note}</div>}
              </div>
              <Badge tone={TONE[request.status]}>{LABEL[request.status]}</Badge>
            </div>
          </Card>
        ))}
      </div>
    </Screen>
  );
}
