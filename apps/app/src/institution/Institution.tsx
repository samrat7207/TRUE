// Institution account: dashboard, Issue ID, issued list, credential detail (revoke / cancel), activity, account.
// The server only ever returns THIS institution's credentials, and has no way to list or search people.
import { useState } from 'react';
import { CLAIM_LABELS, DATE_CLAIMS, TEMPLATES, templateLabel } from '@true/shared';
import { Avatar, Badge, BottomTabs, Card, Chips, Field, INSTITUTION_TABS, Orb, PillButton, Screen, TopBar, go } from '../ui.tsx';
import { api, attempt, setSession, useApi, useSession } from '../session.ts';
import { AccountCard, DeleteAccount } from '../screens/Person.tsx';

const Tabs = ({ active }: { active: string }) => <BottomTabs tabs={INSTITUTION_TABS} active={active} />;

export function InstitutionApp({ path, params }: { path: string; params: URLSearchParams }) {
  switch (path) {
    case '/inst/issue': return <IssueId />;
    case '/inst/issued': return <Issued />;
    case '/inst/credential': return <Detail key={params.get('id')} id={params.get('id') ?? ''} />;
    case '/inst/activity': return <ActivityLog />;
    case '/inst/account': return <Account />;
    default: return <Dashboard />;
  }
}

type Issued = {
  id: string; template: string; status: 'pending' | 'active' | 'declined' | 'cancelled' | 'revoked'; fields: Record<string, string>;
  createdAt: string; claimedAt: string | null; revokedReason: string | null; revokedAt: string | null; statusIndex: number | null;
};
const STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
  pending: { label: 'Pending', tone: 'warn' },
  active: { label: 'Active', tone: 'ok' },
  declined: { label: 'Declined', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  revoked: { label: 'Revoked', tone: 'bad' },
};
const REVOKE_REASONS: Record<string, string> = {
  lost: 'Lost / Stolen', no_longer_valid: 'No longer valid', violation: 'Violation of terms', duplicate: 'Duplicate issued', other: 'Other',
  holder_deleted: 'The holder deleted their account', institution_deleted: 'The institution was deleted',
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

// ---------- dashboard ----------

function Dashboard() {
  const session = useSession()!;
  const { data } = useApi<{ counts: { issued: number; active: number; pending: number; revoked: number }; institution: { verified: boolean } }>('/v1/institution/dashboard');
  const recent = useApi<{ credentials: Issued[] }>('/v1/institution/credentials');
  const tiles = data && ([
    ['Issued', data.counts.issued, 'bg-accent-soft text-accent'],
    ['Active', data.counts.active, 'bg-ok-soft text-ok'],
    ['Pending', data.counts.pending, 'bg-warn-soft text-warn'],
    ['Revoked', data.counts.revoked, 'bg-bad-soft text-bad'],
  ] as const);
  return (
    <Screen tabs={<Tabs active="/inst/home" />}>
      <div className="mb-5 flex items-center gap-3">
        <Avatar name={session.account.name} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{session.account.name}</div>
          {data && (data.institution.verified ? <Badge tone="ok">Verified institution</Badge> : <Badge tone="warn">Unverified institution</Badge>)}
        </div>
      </div>
      {data && !data.institution.verified && (
        <Card tone="warn" className="mb-4"><p className="text-small">People see you as an <b>Unverified institution</b> until the operator of this demo verifies you.</p></Card>
      )}

      <div className="mb-6 grid grid-cols-4 gap-2">
        {tiles?.map(([label, value, colours]) => (
          <div key={label} className={`rounded-row px-1 py-3 text-center ${colours}`}><div className="text-xl font-bold">{value}</div><div className="text-tiny">{label}</div></div>
        ))}
      </div>

      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Recently issued</h2>
        <button onClick={() => go('/inst/issued')} className="text-small text-muted">See all →</button>
      </div>
      <IssuedList credentials={recent.data?.credentials.slice(0, 4) ?? null} />
      <div className="mt-5"><PillButton onClick={() => go('/inst/issue')}>Issue ID</PillButton></div>
    </Screen>
  );
}

function IssuedList({ credentials }: { credentials: Issued[] | null }) {
  if (credentials === null) return <p className="text-small text-muted">Loading…</p>;
  if (credentials.length === 0) return <Card><span className="text-small text-muted">Nothing here yet.</span></Card>;
  return (
    <div className="space-y-2">
      {credentials.map((credential) => (
        <Card key={credential.id} onClick={() => go(`/inst/credential?id=${credential.id}`)}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-semibold">{templateLabel(credential.template)}</div>
              <div className="truncate text-small text-muted">{credential.id} · {credential.fields.name}</div>
              <div className="text-tiny text-muted">{when(credential.createdAt)}</div>
            </div>
            <Badge tone={STATUS[credential.status].tone}>{STATUS[credential.status].label}</Badge>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ---------- Issue ID ----------

function IssueId() {
  const [email, setEmail] = useState('');
  const [checked, setChecked] = useState(false); // the email belongs to a TRUE user
  const [template, setTemplate] = useState('StudentID');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [sent, setSent] = useState('');

  // The only question an institution can ask about people: does this exact email have an account?
  const check = async () => { setError(''); setChecked(await attempt(() => api('/v1/institution/lookup', { email }), setError)); };
  const names = TEMPLATES[template].fields;
  const complete = names.every((name) => (fields[name] ?? '').trim());

  async function send() {
    setError('');
    const values = Object.fromEntries(names.map((name) => [name, fields[name].trim()]));
    await attempt(async () => setSent((await api<{ id: string }>('/v1/institution/offers', { email, template, fields: values })).id), setError);
  }

  if (sent) {
    return (
      <Screen>
        <div className="pt-6"><Orb state="ok" /></div>
        <h1 className="mt-4 text-center text-2xl font-bold">Offer sent</h1>
        <p className="mt-2 mb-6 text-center text-muted">{templateLabel(template)} · {sent}. It appears in the person's Offers tab and becomes Active when they accept.</p>
        <div className="space-y-3">
          <PillButton onClick={() => go(`/inst/credential?id=${sent}`)}>View it</PillButton>
          <PillButton kind="secondary" onClick={() => { setSent(''); setEmail(''); setChecked(false); setFields({}); }}>Issue another</PillButton>
        </div>
      </Screen>
    );
  }

  const input = 'mt-1 w-full rounded-row border border-line bg-surface px-3 py-3 font-normal';
  return (
    <Screen tabs={<Tabs active="/inst/issue" />}>
      <h1 className="text-title font-bold leading-tight">Issue ID</h1>
      <p className="mt-2 mb-4 text-muted">Type the person's email. You cannot browse or search users.</p>

      <label className="block text-small font-semibold">Person's email
        <input type="email" value={email} onChange={(e) => { setEmail(e.target.value); setChecked(false); setError(''); }} className={input} />
      </label>
      {!checked && <div className="mt-3"><PillButton kind="secondary" onClick={check} disabled={!email.includes('@')}>Check email</PillButton></div>}
      {checked && <p className="mt-2 text-small font-semibold text-ok">✓ A TRUE user has this email.</p>}
      {error && <Card tone="bad" className="mt-3"><span className="text-small text-bad">{error}</span></Card>}

      {checked && (
        <>
          <label className="mt-5 block text-small font-semibold">ID type
            <select value={template} onChange={(e) => { setTemplate(e.target.value); setFields({}); }} className={input}>
              {Object.entries(TEMPLATES).map(([value, t]) => <option key={value} value={value}>{t.label}</option>)}
            </select>
          </label>
          <div className="mt-4 mb-1 text-small font-semibold">Fields in a {templateLabel(template)}</div>
          <Card>
            {names.map((name) => (
              <label key={name} className="mb-3 block text-small text-muted last:mb-0">{CLAIM_LABELS[name] ?? name}
                <input type={DATE_CLAIMS.includes(name) ? 'date' : 'text'} value={fields[name] ?? ''} onChange={(e) => setFields({ ...fields, [name]: e.target.value })} className={input + ' text-ink'} />
              </label>
            ))}
          </Card>
          <p className="mt-2 mb-4 text-tiny text-muted">The person can later show any one of these fields without the others. No photos are stored.</p>
          <PillButton onClick={send} disabled={!complete}>Send offer →</PillButton>
        </>
      )}
    </Screen>
  );
}

// ---------- issued list ----------

const FILTERS = { all: 'All', pending: 'Pending', active: 'Active', declined: 'Declined', revoked: 'Revoked' };

function Issued() {
  const [filter, setFilter] = useState<keyof typeof FILTERS>('all');
  const { data } = useApi<{ credentials: Issued[] }>(filter === 'all' ? '/v1/institution/credentials' : `/v1/institution/credentials?status=${filter}`);
  return (
    <Screen tabs={<Tabs active="/inst/issued" />}>
      <h1 className="mb-4 text-title font-bold leading-tight">Issued</h1>
      <Chips options={FILTERS} value={filter} onChange={setFilter} />
      <IssuedList credentials={data?.credentials ?? null} />
    </Screen>
  );
}

// ---------- credential detail, revoke, cancel ----------

function Detail({ id }: { id: string }) {
  const { data, error: loadError, reload } = useApi<{ credential: Issued }>(`/v1/institution/credentials/${id}`);
  const [step, setStep] = useState<'detail' | 'reason' | 'confirm'>('detail');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const credential = data?.credential;
  if (!credential) return <Screen><TopBar back="/inst/issued" /><p className="text-small text-muted">{loadError || 'Loading…'}</p></Screen>;

  // Revoke, step 1: choose a reason (codes only, no free text).
  if (step === 'reason') {
    return (
      <Screen>
        <TopBar title="Revoke ID" />
        <Card className="mb-4"><div className="font-semibold">{templateLabel(credential.template)}</div><div className="text-small text-muted">{credential.id} · {credential.fields.name}</div></Card>
        <div className="mb-1 text-small font-semibold">Reason for revocation</div>
        <div className="mb-5 space-y-2">
          {['lost', 'no_longer_valid', 'violation', 'duplicate', 'other'].map((value) => (
            <Card key={value} onClick={() => setReason(value)} className={reason === value ? 'ring-2 ring-ink' : ''}>
              <div className="flex items-center gap-3"><span className={`h-4 w-4 rounded-pill border-2 ${reason === value ? 'border-ink bg-ink' : 'border-line'}`} />{REVOKE_REASONS[value]}</div>
            </Card>
          ))}
        </div>
        <div className="space-y-3">
          <PillButton kind="danger" disabled={!reason} onClick={() => setStep('confirm')}>Continue</PillButton>
          <PillButton kind="secondary" onClick={() => setStep('detail')}>Cancel</PillButton>
        </div>
      </Screen>
    );
  }
  // Revoke, step 2: confirm.
  if (step === 'confirm') {
    const revoke = async () => { if (await attempt(() => api(`/v1/institution/credentials/${id}/revoke`, { reason }), setError)) { reload(); setStep('detail'); } };
    return (
      <Screen>
        <TopBar />
        <div className="pt-2"><Orb state="bad" /></div>
        <h1 className="mt-4 text-center text-2xl font-bold">Confirm revocation</h1>
        <p className="mt-2 mb-5 text-center text-muted">This {templateLabel(credential.template)} will fail every future check. It cannot be undone; the person would need a new one.</p>
        <Card className="mb-5">
          <Field label="ID">{credential.id}</Field>
          <Field label="Name on it">{credential.fields.name}</Field>
          <Field label="Reason">{REVOKE_REASONS[reason]}</Field>
        </Card>
        {error && <Card tone="bad" className="mb-3"><span className="text-small text-bad">{error}</span></Card>}
        <div className="space-y-3">
          <PillButton kind="danger" onClick={revoke}>Yes, revoke</PillButton>
          <PillButton kind="secondary" onClick={() => setStep('detail')}>Cancel</PillButton>
        </div>
      </Screen>
    );
  }

  const status = STATUS[credential.status];
  return (
    <Screen>
      <TopBar back="/inst/issued" />
      <div className="mb-4 flex items-center justify-between gap-3">
        <div><div className="text-xl font-semibold">{templateLabel(credential.template)}</div><div className="text-small text-muted">{credential.id}</div></div>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      {credential.status === 'revoked' && (
        <Card tone="bad" className="mb-4">
          <div className="font-semibold text-bad">Revoked</div>
          <p className="mt-1 text-small">Reason: {REVOKE_REASONS[credential.revokedReason ?? ''] ?? credential.revokedReason} · {when(credential.revokedAt)}. Checkers refuse it after their next list refresh (a few seconds).</p>
        </Card>
      )}
      <Card className="mb-4">
        <Field label="Offered">{when(credential.createdAt)}</Field>
        <Field label="Accepted by the person">{credential.claimedAt ? when(credential.claimedAt) : 'Not yet'}</Field>
        <Field label="Revocation list position">{credential.statusIndex ?? '—'}</Field>
      </Card>
      <h2 className="mb-2 font-semibold">What you entered</h2>
      <Card className="mb-5">
        {Object.entries(credential.fields).map(([name, value]) => <Field key={name} label={CLAIM_LABELS[name] ?? name}>{value}</Field>)}
      </Card>
      {error && <Card tone="bad" className="mb-3"><span className="text-small text-bad">{error}</span></Card>}
      {credential.status === 'active' && <PillButton kind="danger" onClick={() => { setError(''); setStep('reason'); }}>Revoke</PillButton>}
      {credential.status === 'pending' && (
        <PillButton kind="danger" onClick={async () => { if (await attempt(() => api(`/v1/institution/credentials/${id}/cancel`, {}), setError)) reload(); }}>Cancel offer</PillButton>
      )}
      {credential.status === 'declined' && <p className="text-center text-small text-muted">The person rejected this offer. Nothing was issued.</p>}
    </Screen>
  );
}

// ---------- activity log (ids only) ----------

const EVENTS: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
  'account.created': { label: 'Account created', tone: 'neutral' },
  'credential.offered': { label: 'Offer sent', tone: 'warn' },
  'credential.accepted': { label: 'Accepted', tone: 'ok' },
  'offer.declined': { label: 'Declined', tone: 'neutral' },
  'offer.cancelled': { label: 'Offer cancelled', tone: 'neutral' },
  'credential.revoked': { label: 'Revoked', tone: 'bad' },
};

function ActivityLog() {
  const { data } = useApi<{ events: { id: number; ts: string; type: string; actor: string | null; subject: string }[] }>('/v1/institution/activity');
  const me = useSession()!.account.id;
  return (
    <Screen tabs={<Tabs active="/inst/activity" />}>
      <h1 className="text-title font-bold leading-tight">Activity</h1>
      <p className="mt-2 mb-4 text-small text-muted">Ids only: no names, emails or field values are logged. Checks of an ID never appear here, because checkers do not contact the institution.</p>
      <div className="space-y-2">
        {data?.events.length === 0 && <Card><span className="text-small text-muted">Nothing yet.</span></Card>}
        {data?.events.map((event) => {
          const look = EVENTS[event.type] ?? { label: event.type, tone: 'neutral' as const };
          return (
            <Card key={event.id} onClick={event.subject.startsWith('TR-') ? () => go(`/inst/credential?id=${event.subject}`) : undefined}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-mono text-small font-semibold">{event.subject}</div>
                  <div className="text-tiny text-muted">{when(event.ts)} · by {event.actor === me ? 'this institution' : event.actor ? 'the person' : 'the system'}</div>
                </div>
                <Badge tone={look.tone}>{look.label}</Badge>
              </div>
            </Card>
          );
        })}
      </div>
    </Screen>
  );
}

// ---------- account ----------

function Account() {
  return (
    <Screen tabs={<Tabs active="/inst/account" />}>
      <h1 className="mb-5 text-title font-bold leading-tight">Account</h1>
      <AccountCard />
      <div className="mb-4"><PillButton kind="secondary" onClick={() => { setSession(null); go('/'); }}>Log out</PillButton></div>
      <DeleteAccount consequence="Your signing key is retired and every ID you issued is revoked." />
    </Screen>
  );
}
