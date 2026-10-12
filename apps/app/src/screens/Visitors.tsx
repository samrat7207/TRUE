// A register's visitor list: who was verified through it, with a status looked up live on every refresh.
// Only the register's owner can load this; the server refuses anyone else.
import { useEffect, useState } from 'react';
import { CLAIM_LABELS, templateLabel } from '@true/shared';
import { Avatar, Badge, Card, Chips, Field, PillButton, Screen, TopBar, go } from '../ui.tsx';
import { verifierCall, type Register } from './Registers.tsx';

type Visitor = {
  credentialId: string; name: string; visits: number; firstVerifiedAt: string; lastVerifiedAt: string;
  status: 'valid' | 'revoked' | 'key_compromised'; issuerName: string; type: string; fields: Record<string, unknown>; servedBy: string[];
};
type VisitorList = { register: Register; visitors: Visitor[]; denied: { total: number; byReason: Record<string, number> }; retentionDays: number };

const STATUS = {
  valid: { label: 'Valid', tone: 'ok' },
  revoked: { label: 'Revoked', tone: 'bad' },
  key_compromised: { label: 'Issuer key compromised', tone: 'bad' },
} as const;
const FILTERS = { all: 'All', valid: 'Valid', revoked: 'Revoked' };
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function RegisterVisitors({ id }: { id: string }) {
  const [list, setList] = useState<VisitorList | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<keyof typeof FILTERS>('all');
  const [open, setOpen] = useState(''); // credential id of the visitor whose details are shown

  // Refreshed every 3 seconds, so a revocation shows up here soon after the verifier learns of it.
  useEffect(() => {
    const load = async () => {
      const response = await verifierCall(`/v1/registers/${id}/visits`).catch(() => null);
      if (!response) return;
      const body = await response.json();
      if (response.ok) { setList(body); setError(''); } else setError(body.error.message);
    };
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [id]);

  if (error) return <Screen><TopBar back="/registers" /><Card tone="bad"><span className="text-small text-bad">{error}</span></Card></Screen>;
  if (!list) return <Screen><TopBar back="/registers" /><p className="text-small text-muted">Loading…</p></Screen>;

  // ---------- one visitor ----------
  const visitor = list.visitors.find((v) => v.credentialId === open);
  if (visitor) {
    const status = STATUS[visitor.status];
    return (
      <Screen>
        <div className="mb-5 flex h-10 items-center"><button onClick={() => setOpen('')} aria-label="Back" className="-ml-2 flex h-10 w-10 items-center justify-center text-xl">←</button></div>
        <div className="mb-4 flex items-center gap-3">
          <Avatar name={visitor.name} size={52} />
          <div><div className="text-xl font-semibold">{visitor.name}</div><Badge tone={status.tone}>{status.label}</Badge></div>
        </div>
        {visitor.status !== 'valid' && (
          <Card tone="bad" className="mb-4">
            <p className="text-small">
              {visitor.status === 'revoked' ? 'ID revoked' : "The institution's signing key was marked compromised"} since verification at {when(visitor.lastVerifiedAt)}.
              It was valid when it was checked here.
            </p>
          </Card>
        )}
        <h2 className="mb-2 font-semibold">What they shared with this register</h2>
        <Card className="mb-4">
          {Object.entries(visitor.fields).map(([name, value]) => <Field key={name} label={CLAIM_LABELS[name] ?? name}>{String(value)}</Field>)}
        </Card>
        <Card>
          <Field label="Institution">{visitor.issuerName}</Field>
          <Field label="ID type">{templateLabel(visitor.type)}</Field>
          <Field label="Visits">{visitor.visits}</Field>
          <Field label="First verified">{when(visitor.firstVerifiedAt)}</Field>
          <Field label="Last verified">{when(visitor.lastVerifiedAt)}</Field>
          <Field label="Current status">{status.label} (checked just now)</Field>
          <Field label="Checked by">{visitor.servedBy.map((name) => `instance ${name}`).join(', ')}</Field>
          <Field label="Credential reference">{visitor.credentialId}</Field>
        </Card>
      </Screen>
    );
  }

  // ---------- the list ----------
  const shown = list.visitors.filter((v) => filter === 'all' || (filter === 'valid' ? v.status === 'valid' : v.status !== 'valid'));
  return (
    <Screen>
      <TopBar back="/registers" title={list.register.name} />
      <p className="mb-3 text-center text-small text-muted">{templateLabel(list.register.type)} from {list.register.issuerName}</p>
      <div className="mb-4"><PillButton onClick={() => go(`/register?id=${id}`)}>Show QR to check someone</PillButton></div>

      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Visitors</h2>
        <span className="text-small text-muted">{list.visitors.length} · denied attempts: {list.denied.total}</span>
      </div>
      {list.denied.total > 0 && (
        <p className="mb-3 text-tiny text-muted">Denied: {Object.entries(list.denied.byReason).map(([code, n]) => `${code} × ${n}`).join(', ')}. No details are kept for denied attempts.</p>
      )}
      <Chips options={FILTERS} value={filter} onChange={setFilter} />
      <div className="space-y-2">
        {shown.length === 0 && <Card><span className="text-small text-muted">{list.visitors.length === 0 ? 'Nobody has been verified through this register yet.' : 'Nobody matches this filter.'}</span></Card>}
        {shown.map((v) => (
          <Card key={v.credentialId} onClick={() => setOpen(v.credentialId)}>
            <div className="flex items-center gap-3">
              <Avatar name={v.name} size={40} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{v.name}</div>
                <div className="text-small text-muted">{v.visits} {v.visits === 1 ? 'visit' : 'visits'} · last {when(v.lastVerifiedAt)}</div>
                {v.status !== 'valid' && <div className="text-tiny text-bad">ID revoked since verification at {when(v.lastVerifiedAt)}</div>}
              </div>
              <Badge tone={STATUS[v.status].tone}>{STATUS[v.status].label}</Badge>
            </div>
          </Card>
        ))}
      </div>
      <p className="mt-4 text-tiny text-muted">Visits are kept for {list.retentionDays} days, then deleted. Status is looked up live each time this list refreshes.</p>
    </Screen>
  );
}
