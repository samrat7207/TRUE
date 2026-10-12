// Issuer console: search students, issue a credential, credential detail with revoke, and the registry.
import { useState } from 'react';
import { CREDENTIAL_TYPES } from '@true/shared';
import { Avatar, Badge, Card, Chips, Field, Orb, PillButton, QrPanel, Screen, TopBar, go } from '../ui.tsx';
import {
  REVOKE_REASONS, STATUS_LABEL, STATUS_TONE, api, batchOf, can, dateTime, shortDate, useApi, type Credential, type Student,
} from './api.ts';
import { IssuerTabs, attempt } from './Issuer.tsx';

// ---------- search ----------

export function Search() {
  const [q, setQ] = useState('');
  const { data } = useApi<{ students: Student[] }>(`/v1/students?q=${encodeURIComponent(q)}`);
  return (
    <Screen tabs={<IssuerTabs active="/issuer/search" />}>
      <h1 className="mb-4 text-title font-bold leading-tight">Search</h1>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, PNR or ID" className="mb-4 w-full rounded-row border border-line bg-surface px-4 py-3.5" />
      <div className="space-y-2">
        {data?.students.length === 0 && <Card><span className="text-small text-muted">No student matches "{q}".</span></Card>}
        {data?.students.map((student) => (
          <Card key={student.id} onClick={() => go(`/issuer/issue?student=${student.id}`)}>
            <div className="flex items-center gap-3">
              <Avatar name={student.name} />
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{student.name}</div>
                <div className="truncate text-small text-muted">{student.pnr} · {student.branch}</div>
                <div className="text-tiny text-muted">ID {student.id}</div>
              </div>
              {student.status !== 'active' && <Badge tone="bad">{student.status}</Badge>}
              <span className="text-muted">›</span>
            </div>
          </Card>
        ))}
      </div>
    </Screen>
  );
}

// ---------- issue new credential ----------

type Offer = { credentialId: string; code: string; expiresAt: string; appOfferUrl: string };
// YYYY-MM-DD in the device's own time zone (toISOString would use UTC and can be a day off).
const isoDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export function IssueNew({ studentId }: { studentId: number }) {
  const { data } = useApi<{ students: Student[] }>(`/v1/students?q=${studentId}`);
  const student = data?.students.find((s) => s.id === studentId);
  const [type, setType] = useState('StudentCredential');
  const [validFrom, setValidFrom] = useState(isoDay(new Date()));
  const [validTill, setValidTill] = useState(isoDay(new Date(Date.now() + 365 * 86_400_000)));
  const [error, setError] = useState('');
  const [offer, setOffer] = useState<Offer | null>(null);

  const submit = () => attempt(async () => setOffer(await api<Offer>('/v1/issue', { studentId, type, validFrom, validTill })), setError);

  // ---------- confirmation: the offer the holder scans or pastes ----------
  if (offer && student) {
    return (
      <Screen>
        <div className="pt-4"><Orb state="ok" /></div>
        <h1 className="mt-4 text-center text-2xl font-bold">Offer ready</h1>
        <p className="mt-1 mb-5 text-center text-muted">
          {CREDENTIAL_TYPES[type]} for {student.name}. It becomes Active when the holder collects it.
        </p>
        <QrPanel value={offer.appOfferUrl} caption={`One-time code, valid until ${new Date(offer.expiresAt).toLocaleTimeString()}`} />
        <Card className="my-4">
          <Field label="Credential ID">{offer.credentialId}</Field>
          <Field label="Claim code"><span className="font-mono tracking-widest">{offer.code}</span></Field>
          <div className="pt-2 text-small text-muted">Link to paste in the holder's app:</div>
          <input readOnly value={offer.appOfferUrl} onFocus={(e) => e.target.select()} className="mt-1 w-full rounded-row border border-line bg-soft px-3 py-2 font-mono text-tiny" />
        </Card>
        <div className="space-y-3">
          <PillButton onClick={() => go(`/issuer/credential?id=${offer.credentialId}`)}>View credential</PillButton>
          <PillButton kind="secondary" onClick={() => go('/issuer/search')}>Issue another</PillButton>
        </div>
      </Screen>
    );
  }

  const input = 'mt-1 w-full rounded-row border border-line bg-surface px-3 py-3';
  return (
    <Screen>
      <TopBar back="/issuer/search" title="Issue new credential" />
      {!student ? <p className="text-small text-muted">{data ? 'No such student.' : 'Loading…'}</p> : (
        <>
          <div className="mb-1 text-small font-semibold">Recipient</div>
          <Card className="mb-4">
            <div className="flex items-center gap-3">
              <Avatar name={student.name} />
              <div><div className="font-semibold">{student.name}</div><div className="text-small text-muted">{student.pnr}</div></div>
            </div>
          </Card>

          <label className="mb-4 block text-small font-semibold">Credential type
            <select value={type} onChange={(e) => setType(e.target.value)} className={input + ' font-normal'}>
              {Object.entries(CREDENTIAL_TYPES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>

          <div className="mb-4 grid grid-cols-2 gap-3">
            <label className="block text-small font-semibold">Valid from<input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} className={input + ' font-normal'} /></label>
            <label className="block text-small font-semibold">Valid till<input type="date" value={validTill} onChange={(e) => setValidTill(e.target.value)} className={input + ' font-normal'} /></label>
          </div>

          <div className="mb-1 text-small font-semibold">From the student record (not editable)</div>
          <Card className="mb-5">
            <Field label="Department">{student.branch}</Field>
            <Field label="Batch">{batchOf(student.pnr)}</Field>
            <Field label="Class / Section">{student.class} – {student.section}</Field>
          </Card>

          {!can('issue') && <Card tone="warn" className="mb-3"><span className="text-small">Your role cannot issue credentials. The server will refuse.</span></Card>}
          {error && <Card tone="bad" className="mb-3"><span className="text-small text-bad">{error}</span></Card>}
          <PillButton onClick={submit} disabled={student.status !== 'active'}>Issue credential →</PillButton>
          {student.status !== 'active' && <p className="mt-2 text-small text-muted">This student is revoked and cannot be issued to.</p>}
        </>
      )}
    </Screen>
  );
}

// ---------- credential detail, and the revoke steps ----------

export function CredentialDetail({ id }: { id: string }) {
  const { data, error: loadError, reload } = useApi<{ credential: Credential }>(`/v1/registry/${id}`);
  const directory = useApi<{ staff: { id: string; name: string }[] }>('/v1/staff/directory');
  const [step, setStep] = useState<'detail' | 'reason' | 'confirm'>('detail');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const credential = data?.credential;
  const staffName = (staffId: string | null) => (staffId ? `${directory.data?.staff.find((s) => s.id === staffId)?.name ?? ''} (${staffId})`.trim() : '—');

  if (!credential) return <Screen><TopBar back="/issuer/registry" /><p className="text-small text-muted">{loadError || 'Loading…'}</p></Screen>;

  const holder = (
    <Card className="mb-4">
      <div className="flex items-center gap-3">
        <Avatar name={credential.student_name} />
        <div><div className="font-semibold">{credential.student_name}</div><div className="text-small text-muted">{credential.student_pnr}</div></div>
      </div>
    </Card>
  );

  // Step 1 of revoking: choose a reason (codes only, no free text).
  if (step === 'reason') {
    return (
      <Screen>
        <TopBar title="Revoke credential" />
        {holder}
        <div className="mb-1 text-small font-semibold">Credential</div>
        <Card className="mb-4"><div className="font-semibold">{CREDENTIAL_TYPES[credential.type]}</div><div className="text-small text-muted">{credential.id}</div></Card>
        <div className="mb-1 text-small font-semibold">Reason for revocation</div>
        <div className="mb-5 space-y-2">
          {Object.entries(REVOKE_REASONS).map(([value, label]) => (
            <Card key={value} onClick={() => setReason(value)} className={reason === value ? 'ring-2 ring-ink' : ''}>
              <div className="flex items-center gap-3">
                <span className={`h-4 w-4 rounded-pill border-2 ${reason === value ? 'border-ink bg-ink' : 'border-line'}`} />{label}
              </div>
            </Card>
          ))}
        </div>
        <div className="space-y-3">
          <PillButton kind="danger" disabled={!reason} onClick={() => setStep('confirm')}>Revoke credential</PillButton>
          <PillButton kind="secondary" onClick={() => setStep('detail')}>Cancel</PillButton>
        </div>
      </Screen>
    );
  }

  // Step 2: confirm.
  if (step === 'confirm') {
    const revoke = async () => {
      if (await attempt(() => api(`/v1/registry/${id}/revoke`, { reason }), setError)) { reload(); setStep('detail'); }
    };
    return (
      <Screen>
        <TopBar />
        <div className="pt-2"><Orb state="bad" /></div>
        <h1 className="mt-4 text-center text-2xl font-bold">Confirm revocation</h1>
        <p className="mt-2 mb-5 text-center text-muted">
          This {CREDENTIAL_TYPES[credential.type]} will be invalid for all future verifications. It cannot be undone; the holder would need a new credential.
        </p>
        <Card className="mb-5">
          <Field label="Credential">{credential.id}</Field>
          <Field label="Holder">{credential.student_name}</Field>
          <Field label="Reason">{REVOKE_REASONS[reason]}</Field>
          <Field label="Valid till">{shortDate(credential.valid_till)}</Field>
        </Card>
        {error && <Card tone="bad" className="mb-3"><span className="text-small text-bad">{error}</span></Card>}
        <div className="space-y-3">
          <PillButton kind="danger" onClick={revoke}>Yes, revoke</PillButton>
          <PillButton kind="secondary" onClick={() => setStep('detail')}>Cancel</PillButton>
        </div>
      </Screen>
    );
  }

  const status = credential.display_status;
  return (
    <Screen>
      <TopBar back="/issuer/registry" />
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <div className="text-xl font-semibold">{CREDENTIAL_TYPES[credential.type]}</div>
          <div className="text-small text-muted">{credential.id}</div>
        </div>
        <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
      </div>

      {status === 'revoked' && (
        <Card tone="bad" className="mb-4">
          <div className="font-semibold text-bad">Revoked</div>
          <p className="mt-1 text-small">
            Reason: {REVOKE_REASONS[credential.revoked_reason ?? ''] ?? credential.revoked_reason} · by {staffName(credential.revoked_by)} · {dateTime(credential.revoked_at)}.
            Verifiers refuse it after their next list refresh.
          </p>
        </Card>
      )}

      {holder}
      <Card className="mb-5">
        <Field label="Department">{credential.student_branch}</Field>
        <Field label="Holder status">{credential.student_status === 'active' ? 'Active student' : 'Revoked student'}</Field>
        <Field label="Issued by">{staffName(credential.issued_by)}</Field>
        <Field label="Offer created">{dateTime(credential.created_at)}</Field>
        <Field label="Collected by holder">{credential.claimed_at ? dateTime(credential.claimed_at) : 'Not yet'}</Field>
        <Field label="Valid from">{shortDate(credential.valid_from)}</Field>
        <Field label="Valid till">{shortDate(credential.valid_till)}</Field>
        <Field label="Revocation list position">{credential.status_list_index ?? '—'}</Field>
      </Card>

      {status === 'active' && (can('revoke')
        ? <PillButton kind="danger" onClick={() => { setError(''); setStep('reason'); }}>Revoke credential</PillButton>
        : <p className="text-center text-small text-muted">Your role cannot revoke credentials.</p>)}
      {status === 'pending' && <p className="text-center text-small text-muted">Waiting for the holder to collect it with claim code <span className="font-mono">{credential.claim_code}</span>.</p>}
    </Screen>
  );
}

// ---------- registry ----------

const REGISTRY_FILTERS = { all: 'All', active: 'Active', pending: 'Pending', revoked: 'Revoked' };

export function Registry() {
  const [filter, setFilter] = useState<keyof typeof REGISTRY_FILTERS>('all');
  const { data } = useApi<{ credentials: Credential[] }>(filter === 'all' ? '/v1/registry' : `/v1/registry?status=${filter}`);
  return (
    <Screen tabs={<IssuerTabs active="/issuer/registry" />}>
      <h1 className="mb-4 text-title font-bold leading-tight">Registry</h1>
      <Chips options={REGISTRY_FILTERS} value={filter} onChange={setFilter} />
      <div className="space-y-2">
        {data?.credentials.length === 0 && <Card><span className="text-small text-muted">No credentials here yet.</span></Card>}
        {data?.credentials.map((credential) => (
          <Card key={credential.id} onClick={() => go(`/issuer/credential?id=${credential.id}`)}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-semibold">{credential.id}</div>
                <div className="text-small text-muted">{CREDENTIAL_TYPES[credential.type]}</div>
                <div className="truncate text-small text-muted">{credential.student_name}</div>
                <div className="text-tiny text-muted">{shortDate(credential.created_at)}</div>
              </div>
              <Badge tone={STATUS_TONE[credential.display_status]}>{STATUS_LABEL[credential.display_status]}</Badge>
            </div>
          </Card>
        ))}
      </div>
    </Screen>
  );
}
