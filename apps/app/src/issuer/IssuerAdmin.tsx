// Issuer console: activity log, signing keys, reports and staff management.
import { useState } from 'react';
import { CREDENTIAL_TYPES } from '@true/shared';
import { Avatar, Badge, Card, Chips, Field, PillButton, Screen, TopBar } from '../ui.tsx';
import { api, can, getSession, shortDate, useApi, type AuditEvent, type Credential } from './api.ts';
import { EventList, IssuerTabs, attempt } from './Issuer.tsx';

// ---------- activity log ----------

const LOG_FILTERS = { all: 'All', issue: 'Issue', verify: 'Verify', revoke: 'Revoke' };

export function ActivityLog() {
  const [filter, setFilter] = useState<keyof typeof LOG_FILTERS>('all');
  const { data } = useApi<{ events: AuditEvent[] }>(filter === 'verify' ? null : filter === 'all' ? '/v1/audit' : `/v1/audit?kind=${filter}`);
  const registry = useApi<{ credentials: Credential[] }>('/v1/registry');
  return (
    <Screen>
      <TopBar back="/issuer/more" title="Activity log" />
      <Chips options={LOG_FILTERS} value={filter} onChange={setFilter} />
      {filter === 'verify'
        ? (
          <Card>
            <div className="font-semibold">The issuer has no verification events</div>
            <p className="mt-1 text-small text-muted">
              By design. A verifier checks a credential using its signature, the chain registry and the public revocation list.
              It never contacts the issuer, so the issuer cannot see where or when a student shows their ID.
            </p>
          </Card>
        )
        : <EventList events={data?.events ?? null} credentials={registry.data?.credentials ?? []} />}
      <p className="mt-4 text-small text-muted">The log stores staff ids and credential ids only. Names shown here are looked up on this screen.</p>
    </Screen>
  );
}

// ---------- signing keys ----------

type Key = { kid: string; state: 'Active' | 'Retired' | 'Compromised'; createdAt: string };
const KEY_TONE = { Active: 'ok', Retired: 'neutral', Compromised: 'bad' } as const;

export function Keys() {
  const { data, reload } = useApi<{ keys: Key[] }>('/v1/keys');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(''); // key id waiting for a second tap
  const admin = can('keys');

  async function act(path: string, done: string) {
    setError(''); setMessage(''); setConfirm('');
    if (await attempt(async () => { const result = await api(path, {}); setMessage(`${done} Active key: ${result.activeKeyId}.`); }, setError)) reload();
  }

  return (
    <Screen>
      <TopBar back="/issuer/more" title="Signing keys" />
      <p className="mb-4 text-small text-muted">The public halves and their states are on the chain. Verifiers read the state on every check.</p>
      {!admin && <Card tone="warn" className="mb-4"><span className="text-small">Only an admin can rotate keys or mark one compromised. You can view them.</span></Card>}
      <div className="mb-4 space-y-2">
        {data?.keys.map((key) => (
          <Card key={key.kid}>
            <div className="flex items-center justify-between">
              <div><div className="font-mono font-semibold">{key.kid}</div><div className="text-tiny text-muted">created {shortDate(key.createdAt)}</div></div>
              <Badge tone={KEY_TONE[key.state]}>{key.state}</Badge>
            </div>
            {admin && key.state !== 'Compromised' && (
              <div className="mt-3">
                {confirm === key.kid
                  ? <PillButton kind="danger" onClick={() => act(`/v1/keys/${key.kid}/compromise`, `${key.kid} marked Compromised: verifiers now reject everything it signed.`)}>Yes, mark {key.kid} compromised</PillButton>
                  : <PillButton kind="secondary" onClick={() => setConfirm(key.kid)}>Mark compromised</PillButton>}
              </div>
            )}
          </Card>
        ))}
      </div>
      {message && <Card tone="ok" className="mb-3"><span className="text-small">{message}</span></Card>}
      {error && <Card tone="bad" className="mb-3"><span className="text-small text-bad">{error}</span></Card>}
      {admin && <PillButton onClick={() => act('/v1/keys/rotate', 'Key rotated; the old key is Retired and its credentials stay valid.')}>Rotate key</PillButton>}
      <p className="mt-4 text-small text-muted">Retired = replaced normally, old credentials stay valid. Compromised = leaked, holders must be re-issued.</p>
    </Screen>
  );
}

// ---------- reports ----------

type Report = {
  since: string;
  counts: { issued: number; offered: number; revoked: number; active: number; pending: number };
  trend: { day: string; issued: number }[];
  byType: { type: string; count: number }[];
};

export function Reports() {
  const { data } = useApi<Report>('/v1/reports');
  if (!data) return <Screen tabs={<IssuerTabs active="/issuer/reports" />}><p className="text-small text-muted">Loading…</p></Screen>;
  const tiles = [
    ['Issued', data.counts.issued, 'bg-accent-soft text-accent'],
    ['Active', data.counts.active, 'bg-ok-soft text-ok'],
    ['Pending', data.counts.pending, 'bg-warn-soft text-warn'],
    ['Revoked', data.counts.revoked, 'bg-bad-soft text-bad'],
  ] as const;

  // The trend line is drawn from the 30 real daily counts.
  const highest = Math.max(1, ...data.trend.map((point) => point.issued));
  const points = data.trend.map((point, i) => `${(i / 29) * 300},${90 - (point.issued / highest) * 80}`).join(' ');
  const totalByType = data.byType.reduce((sum, row) => sum + row.count, 0);
  const colours = ['bg-accent', 'bg-ok', 'bg-warn'];

  return (
    <Screen tabs={<IssuerTabs active="/issuer/reports" />}>
      <h1 className="text-title font-bold leading-tight">Reports</h1>
      <p className="mt-1 mb-4 text-small text-muted">Last 30 days, since {shortDate(data.since)}. Active and Pending are as of now.</p>

      <div className="mb-5 grid grid-cols-4 gap-2">
        {tiles.map(([label, value, colours]) => (
          <div key={label} className={`rounded-row px-1 py-3 text-center ${colours}`}><div className="text-xl font-bold">{value}</div><div className="text-tiny">{label}</div></div>
        ))}
      </div>

      <Card className="mb-4">
        <div className="mb-2 flex items-baseline justify-between"><span className="font-semibold">Issuance trend</span><span className="text-tiny text-muted">credentials collected per day · peak {highest === 1 && data.counts.issued === 0 ? 0 : highest}</span></div>
        <svg viewBox="0 0 300 100" className="w-full" role="img" aria-label="Credentials collected per day over the last 30 days">
          <line x1="0" y1="90" x2="300" y2="90" stroke="var(--color-line)" />
          <polyline points={points} fill="none" stroke="var(--color-accent)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
        <div className="flex justify-between text-tiny text-muted"><span>{shortDate(data.trend[0].day)}</span><span>{shortDate(data.trend[29].day)}</span></div>
      </Card>

      <Card>
        <div className="mb-3 font-semibold">Credential type distribution</div>
        {totalByType === 0 && <p className="text-small text-muted">No credentials collected in this period.</p>}
        {totalByType > 0 && data.byType.map((row, i) => {
          const percent = Math.round((row.count / totalByType) * 100);
          return (
            <div key={row.type} className="mb-2.5">
              <div className="flex justify-between text-small"><span>{CREDENTIAL_TYPES[row.type]}</span><span className="text-muted">{row.count} · {percent}%</span></div>
              <div className="mt-1 h-2 rounded-pill bg-soft"><div className={`h-2 rounded-pill ${colours[i % colours.length]}`} style={{ width: `${percent}%` }} /></div>
            </div>
          );
        })}
      </Card>
    </Screen>
  );
}

// ---------- staff ----------

type StaffMember = { id: string; name: string; role: string; active: number };
const ROLES = { issuer: 'Issuer: issues credentials', revoker: 'Revoker: revokes credentials', auditor: 'Auditor: read-only', admin: 'Admin: everything, plus staff and keys' };

export function Staff() {
  const admin = can('staff');
  const { data, reload } = useApi<{ staff: StaffMember[] }>(admin ? '/v1/staff' : null);
  const [name, setName] = useState('');
  const [role, setRole] = useState('issuer');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const me = getSession()!.staff.id;

  async function add() {
    setError('');
    if (await attempt(() => api('/v1/staff', { name: name.trim(), role, pin }), setError)) { setName(''); setPin(''); reload(); }
  }
  const deactivate = async (id: string) => { setError(''); if (await attempt(() => api(`/v1/staff/${id}/deactivate`, {}), setError)) reload(); };

  const input = 'mt-1 w-full rounded-row border border-line bg-surface px-3 py-3 font-normal';
  return (
    <Screen>
      <TopBar back="/issuer/more" title="Staff" />
      {!admin ? <Card tone="warn"><span className="text-small">Only an admin can see and manage staff.</span></Card> : (
        <>
          <div className="mb-5 space-y-2">
            {data?.staff.map((person) => (
              <Card key={person.id}>
                <div className="flex items-center gap-3">
                  <Avatar name={person.name} size={40} />
                  <div className="min-w-0 flex-1"><div className="font-semibold">{person.name}</div><div className="text-small text-muted">{person.id} · {person.role}</div></div>
                  {person.active
                    ? (person.id === me ? <Badge tone="ok">You</Badge> : <button onClick={() => deactivate(person.id)} className="rounded-pill border border-bad/40 bg-bad-soft px-3 py-1 text-small font-semibold text-bad">Deactivate</button>)
                    : <Badge>Inactive</Badge>}
                </div>
              </Card>
            ))}
          </div>

          <h2 className="mb-2 font-semibold">Add staff</h2>
          <Card>
            <label className="block text-small font-semibold">Name<input value={name} onChange={(e) => setName(e.target.value)} className={input} /></label>
            <label className="mt-3 block text-small font-semibold">Role
              <select value={role} onChange={(e) => setRole(e.target.value)} className={input}>
                {Object.entries(ROLES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="mt-3 block text-small font-semibold">PIN (4 to 8 digits)
              <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} className={input} />
            </label>
            <div className="mt-4"><PillButton onClick={add} disabled={name.trim().length < 2 || pin.length < 4}>Add staff member</PillButton></div>
            <p className="mt-2 text-tiny text-muted">Only a salted hash of the PIN is stored.</p>
          </Card>
          {error && <Card tone="bad" className="mt-3"><span className="text-small text-bad">{error}</span></Card>}
        </>
      )}
      <div className="mt-4 text-small text-muted"><Field label="Signed in as">{me}</Field></div>
    </Screen>
  );
}
