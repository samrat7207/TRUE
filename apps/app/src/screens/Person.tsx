// Person: Activity, Discover and Profile (log out, delete account).
import { useEffect, useState } from 'react';
import { CLAIM_LABELS, INSTITUTION_CATEGORIES } from '@true/shared';
import { getHistory, resetWallet, type HistoryEntry } from '@true/wallet-core';
import { Avatar, Badge, BottomTabs, Card, Field, PillButton, Screen, TopBar, go } from '../ui.tsx';
import { api, attempt, setSession, useSession } from '../session.ts';
import { useCards } from '../wallet.ts';

// ---------- Activity: what was shared, with whom, when, and the result ----------

export function Activity() {
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  useEffect(() => { getHistory().then(setHistory); }, []);
  return (
    <Screen tabs={<BottomTabs active="/activity" />}>
      <h1 className="text-title font-bold leading-tight">Activity</h1>
      <p className="mt-2 mb-5 text-muted">Every request you answered. Stored only on this device.</p>
      <div className="space-y-3">
        {history?.length === 0 && <Card><span className="text-small text-muted">Nobody has asked for anything yet.</span></Card>}
        {history?.map((entry, i) => {
          const verified = entry.outcome === 'verified';
          return (
            <Card key={i}>
              <div className="flex items-start gap-3">
                <Avatar name={entry.verifierName} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-semibold">{entry.verifierName}</span>
                    <Badge tone={verified ? 'ok' : entry.decision === 'declined' ? 'neutral' : 'bad'}>{verified ? 'Verified' : entry.outcome}</Badge>
                  </div>
                  <div className="text-small text-muted">
                    {entry.decision === 'shared' ? 'Shared: ' : 'Not shared: '}
                    {entry.claims.length ? entry.claims.map((name) => CLAIM_LABELS[name] ?? name).join(', ') : 'nothing'}
                  </div>
                  <div className="text-tiny text-muted">{new Date(entry.at).toLocaleString()}</div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </Screen>
  );
}

// ---------- Discover: one honest card about what is not available ----------

export function Discover() {
  return (
    <Screen tabs={<BottomTabs active="/discover" />}>
      <h1 className="text-title font-bold leading-tight">Discover</h1>
      <p className="mt-2 mb-5 text-muted">More places to get IDs from.</p>
      <Card>
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold">Government documents</span>
          <Badge tone="neutral">Not available</Badge>
        </div>
        <p className="mt-2 text-small text-muted">DigiLocker / Aadhaar: planned, needs an official partnership. Not available.</p>
      </Card>
    </Screen>
  );
}

// ---------- delete account (used by people and institutions) ----------

// Asks for the password again, then deletes the account on the server. `afterwards` cleans up this device.
export function DeleteAccount({ consequence, afterwards }: { consequence: string; afterwards?: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function remove() {
    setError('');
    if (!(await attempt(() => api('/v1/auth/delete', { password }), setError))) return;
    await afterwards?.();
    setSession(null);
    go('/');
  }

  return (
    <Card tone="bad">
      <div className="font-semibold text-bad">Delete account</div>
      <p className="mt-1 mb-3 text-small">{consequence} This cannot be undone.</p>
      {!open ? <PillButton kind="secondary" onClick={() => setOpen(true)}>Delete my account…</PillButton> : (
        <>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Type your password to confirm" autoComplete="current-password" className="mb-3 w-full rounded-row border border-line bg-surface px-4 py-3" />
          {error && <p className="mb-2 text-small text-bad">{error}</p>}
          <div className="grid grid-cols-2 gap-2">
            <PillButton kind="secondary" onClick={() => { setOpen(false); setPassword(''); }}>Cancel</PillButton>
            <PillButton kind="danger" onClick={remove} disabled={!password}>Yes, delete</PillButton>
          </div>
        </>
      )}
    </Card>
  );
}

// Name, email and kind of the logged-in account, with Log out.
export function AccountCard() {
  const session = useSession()!;
  const { account } = session;
  return (
    <>
      <div className="mb-6 flex flex-col items-center gap-2">
        <Avatar name={account.name} size={72} />
        <div className="text-lg font-semibold">{account.name}</div>
        <div className="text-small text-muted">{account.email}</div>
      </div>
      <Card className="mb-4">
        <Field label="Account type">{account.kind === 'person' ? 'Person' : `Institution · ${INSTITUTION_CATEGORIES[account.category ?? 'other']}`}</Field>
        <Field label="Email">{account.email} (not verified in this demo)</Field>
      </Card>
    </>
  );
}

// ---------- Profile ----------

export function Profile() {
  const { cards } = useCards();
  return (
    <Screen>
      <TopBar back="/home" title="Profile" />
      <AccountCard />
      <Card className="mb-4">
        <Field label="IDs in this wallet">{cards ? cards.length : '…'}</Field>
        <Field label="Where they are kept">This device only</Field>
        <Field label="Private key">Made on this device, cannot be exported</Field>
      </Card>
      <div className="mb-4"><PillButton kind="secondary" onClick={() => { setSession(null); go('/'); }}>Log out</PillButton></div>
      <DeleteAccount
        consequence="Every ID you hold is revoked at its institution (reason: holder deleted), and your wallet on this device is cleared."
        afterwards={resetWallet}
      />
    </Screen>
  );
}
