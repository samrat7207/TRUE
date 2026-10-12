// Issuer console: staff PIN sign-in, dashboard and the "More" menu. Also decides which issuer screen to show.
import { useEffect, useState } from 'react';
import { CREDENTIAL_TYPES, URLS } from '@true/shared';
import { Avatar, Badge, BottomTabs, Card, ISSUER_TABS, PillButton, Screen, TopBar, go } from '../ui.tsx';
import {
  EVENT_LABEL, ago, api, getSession, setSession, signOut, useApi, type AuditEvent, type Credential,
} from './api.ts';
import { Search, IssueNew, CredentialDetail, Registry } from './IssuerWork.tsx';
import { ActivityLog, Keys, Reports, Staff } from './IssuerAdmin.tsx';
import { PendingRequests } from './IssuerRequests.tsx';

export const IssuerTabs = ({ active }: { active: string }) => <BottomTabs tabs={ISSUER_TABS} active={active} />;

export function IssuerApp({ path, params }: { path: string; params: URLSearchParams }) {
  // No session: every issuer address shows the PIN screen.
  if (!getSession()) return <PinScreen />;
  switch (path) {
    case '/issuer/search': return <Search />;
    case '/issuer/issue': return <IssueNew studentId={Number(params.get('student'))} />;
    case '/issuer/credential': return <CredentialDetail key={params.get('id')} id={params.get('id') ?? ''} />;
    case '/issuer/registry': return <Registry />;
    case '/issuer/activity': return <ActivityLog />;
    case '/issuer/keys': return <Keys />;
    case '/issuer/reports': return <Reports />;
    case '/issuer/staff': return <Staff />;
    case '/issuer/requests': return <PendingRequests />;
    case '/issuer/more': return <More />;
    default: return <Dashboard />;
  }
}

// ---------- staff PIN sign-in ----------

type DirectoryEntry = { id: string; name: string; role: string };

function PinScreen() {
  const [directory, setDirectory] = useState<{ issuerName: string; staff: DirectoryEntry[] } | null>(null);
  const [chosen, setChosen] = useState<DirectoryEntry | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(URLS.issuerApi + '/v1/staff/directory').then((r) => r.json()).then(setDirectory).catch(() => setError('The issuer API is not reachable.'));
  }, []);

  async function signIn() {
    if (!chosen) return;
    setBusy(true);
    setError('');
    const response = await fetch(URLS.issuerApi + '/v1/staff/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ staffId: chosen.id, pin }),
    });
    const body = await response.json();
    setBusy(false);
    if (!response.ok) { setPin(''); return setError(body.error.message); }
    setSession({ token: body.token, staff: body.staff });
    go('/issuer/home');
  }

  return (
    <Screen>
      <TopBar back="/" />
      <h1 className="text-title font-bold leading-tight">Staff sign-in</h1>
      <p className="mt-2 mb-5 text-muted">{directory?.issuerName ?? '…'}. Choose who you are, then enter your PIN.</p>

      <div className="mb-5 space-y-2">
        {directory?.staff.map((person) => (
          <Card key={person.id} onClick={() => { setChosen(person); setPin(''); setError(''); }} className={chosen?.id === person.id ? 'ring-2 ring-ink' : ''}>
            <div className="flex items-center gap-3">
              <Avatar name={person.name} size={40} />
              <div className="flex-1">
                <div className="font-semibold">{person.name}</div>
                <div className="text-small text-muted">{person.id}</div>
              </div>
              <Badge>{person.role}</Badge>
            </div>
          </Card>
        ))}
      </div>

      {chosen && (
        <>
          <input
            type="password" inputMode="numeric" autoFocus value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter') signIn(); }} placeholder={`PIN for ${chosen.name}`}
            className="mb-3 w-full rounded-row border border-line bg-surface px-4 py-3.5 text-center text-xl tracking-[0.5em]"
          />
          <PillButton onClick={signIn} disabled={busy || pin.length < 4}>{busy ? 'Checking…' : 'Sign in'}</PillButton>
        </>
      )}
      {error && <Card tone="bad" className="mt-3"><span className="text-small text-bad">{error}</span></Card>}
      <p className="mt-5 text-small text-muted">Demo PINs are in the project's .env file (STAFF_PIN_ADMIN and so on). Five wrong PINs lock that staff id for a minute.</p>
    </Screen>
  );
}

// ---------- dashboard ----------

type DashboardData = { issuer: { name: string }; counts: { issued: number; active: number; pending: number; revoked: number }; recent: AuditEvent[] };

export function Dashboard() {
  const session = getSession()!;
  const { data } = useApi<DashboardData>('/v1/dashboard');
  const registry = useApi<{ credentials: Credential[] }>('/v1/registry');
  const tiles = data && ([
    ['Total issued', data.counts.issued, 'bg-accent-soft text-accent'],
    ['Active', data.counts.active, 'bg-ok-soft text-ok'],
    ['Pending', data.counts.pending, 'bg-warn-soft text-warn'],
    ['Revoked', data.counts.revoked, 'bg-bad-soft text-bad'],
  ] as const);

  return (
    <Screen tabs={<IssuerTabs active="/issuer/home" />}>
      <div className="mb-5 flex items-center gap-3">
        <Avatar name={data?.issuer.name ?? 'Issuer'} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{data?.issuer.name ?? '…'}</div>
          <div className="text-small text-muted">{session.staff.name} · {session.staff.role}</div>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-4 gap-2">
        {tiles?.map(([label, value, colours]) => (
          <div key={label} className={`rounded-row px-1 py-3 text-center ${colours}`}>
            <div className="text-xl font-bold">{value}</div>
            <div className="text-tiny">{label}</div>
          </div>
        ))}
      </div>

      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Recent activity</h2>
        <button onClick={() => go('/issuer/activity')} className="text-small text-muted">See all →</button>
      </div>
      <EventList events={data?.recent ?? null} credentials={registry.data?.credentials ?? []} />

      <div className="mt-5"><PillButton onClick={() => go('/issuer/search')}>Issue new credential</PillButton></div>
    </Screen>
  );
}

// Audit events hold identifiers only. Names are joined in HERE, on the issuer's own screen,
// from the registry the console already loaded.
export function EventList({ events, credentials }: { events: AuditEvent[] | null; credentials: Credential[] }) {
  if (events === null) return <p className="text-small text-muted">Loading…</p>;
  if (events.length === 0) return <Card><span className="text-small text-muted">Nothing yet.</span></Card>;
  return (
    <div className="space-y-2">
      {events.map((event) => {
        const look = EVENT_LABEL[event.type] ?? { label: event.type, tone: 'neutral' as const };
        const credential = credentials.find((c) => c.id === event.subject);
        return (
          <Card key={event.id} onClick={credential ? () => go(`/issuer/credential?id=${credential.id}`) : undefined}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-semibold">{credential ? CREDENTIAL_TYPES[credential.type] : event.subject}</div>
                <div className="truncate text-small text-muted">
                  {credential ? `${credential.id} · ${credential.student_name}` : look.label}
                </div>
                <div className="text-tiny text-muted">{ago(event.ts)}{event.staff_id ? ` · by ${event.staff_id}` : ' · by the holder'}</div>
              </div>
              <Badge tone={look.tone}>{look.label}</Badge>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ---------- more ----------

function More() {
  const session = getSession()!;
  const pending = useApi<{ requests: unknown[] }>('/v1/requests-inbox');
  const links: [string, string, string][] = [
    ['/issuer/requests', 'Pending requests', pending.data ? `${pending.data.requests.length} waiting` : 'Requests sent by holders'],
    ['/issuer/activity', 'Activity log', 'Every issuer action, by staff id'],
    ['/issuer/keys', 'Signing keys', 'States, rotate, mark compromised'],
    ['/issuer/staff', 'Staff', 'Roles and PINs (admin only)'],
  ];
  return (
    <Screen tabs={<IssuerTabs active="/issuer/more" />}>
      <h1 className="mb-5 text-title font-bold leading-tight">More</h1>
      <Card className="mb-4">
        <div className="flex items-center gap-3">
          <Avatar name={session.staff.name} />
          <div>
            <div className="font-semibold">{session.staff.name}</div>
            <div className="text-small text-muted">{session.staff.id} · {session.staff.role}</div>
          </div>
        </div>
      </Card>
      <div className="mb-5 space-y-2">
        {links.map(([path, title, hint]) => (
          <Card key={path} onClick={() => go(path)}>
            <div className="flex items-center justify-between">
              <div><div className="font-semibold">{title}</div><div className="text-small text-muted">{hint}</div></div>
              <span className="text-muted">›</span>
            </div>
          </Card>
        ))}
      </div>
      <PillButton kind="secondary" onClick={signOut}>Sign out</PillButton>
    </Screen>
  );
}

// Used by screens that change something: runs the call and reports the server's refusal, if any.
export async function attempt(action: () => Promise<unknown>, setError: (message: string) => void): Promise<boolean> {
  try { await action(); return true; } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); return false; }
}
export { api };
