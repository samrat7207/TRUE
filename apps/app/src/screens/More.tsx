// Activity, Discover and Profile / Settings.
import { useEffect, useState } from 'react';
import { CLAIM_LABELS, URLS } from '@true/shared';
import { getHistory, getSettings, resetWallet, saveSettings, type HistoryEntry } from '@true/wallet-core';
import { Avatar, Badge, BottomTabs, Card, Field, PillButton, Screen, TopBar, go } from '../ui.tsx';
import { useCards, useHolderName } from '../wallet.ts';

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
      <p className="mt-2 mb-5 text-muted">More places to get credentials from.</p>
      <Card>
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold">Government documents</span>
          <Badge tone="neutral">Not available</Badge>
        </div>
        <p className="mt-2 text-small text-muted">
          DigiLocker / Aadhaar: planned, needs an official partnership. Not available.
        </p>
      </Card>
    </Screen>
  );
}

// ---------- Profile / Settings ----------

export function Profile() {
  const { cards } = useCards();
  const shownName = useHolderName(cards);
  const [holderName, setHolderName] = useState('');
  const [issuerApi, setIssuerApi] = useState('');
  const [saved, setSaved] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    getSettings().then((settings) => {
      setHolderName(settings.holderName ?? '');
      setIssuerApi(settings.issuerApi ?? '');
    });
  }, []);

  async function save() {
    await saveSettings({ holderName: holderName.trim(), issuerApi: issuerApi.trim().replace(/\/+$/, '') });
    setSaved(true);
  }

  const input = 'mt-1 w-full rounded-row border border-line bg-surface px-4 py-3 text-small';
  return (
    <Screen>
      <TopBar back="/home" title="Profile" />
      <div className="mb-6 flex flex-col items-center gap-2">
        <Avatar name={holderName || shownName || 'You'} size={72} />
        <div className="text-lg font-semibold">{holderName || shownName || 'No name yet'}</div>
      </div>

      <Card className="mb-4">
        <label className="block text-small text-muted">
          Your name (used for the greeting; never sent anywhere)
          <input value={holderName} onChange={(e) => { setHolderName(e.target.value); setSaved(false); }} placeholder={shownName || 'Your name'} className={input} />
        </label>
        <label className="mt-4 block text-small text-muted">
          Backend address (issuer API used to claim credentials)
          <input value={issuerApi} onChange={(e) => { setIssuerApi(e.target.value); setSaved(false); }} placeholder={URLS.issuerApi} className={input + ' font-mono'} />
        </label>
        <div className="mt-4"><PillButton onClick={save}>{saved ? 'Saved' : 'Save'}</PillButton></div>
      </Card>

      <Card className="mb-4">
        <Field label="Credentials in this wallet">{cards ? cards.length : '…'}</Field>
        <Field label="Where data is kept">This device only</Field>
        <Field label="Private key">Made on this device, cannot be exported</Field>
      </Card>

      <Card tone="bad" className="mb-4">
        <div className="font-semibold text-bad">Reset wallet</div>
        <p className="mt-1 mb-3 text-small">Deletes the key, every credential, the activity list and these settings from this device. Credentials must be issued again afterwards.</p>
        {confirmReset
          ? <PillButton kind="danger" onClick={() => resetWallet().then(() => go('/'))}>Yes, delete everything</PillButton>
          : <PillButton kind="secondary" onClick={() => setConfirmReset(true)}>Reset wallet</PillButton>}
      </Card>

      <PillButton kind="secondary" onClick={() => go('/')}>Switch role</PillButton>
    </Screen>
  );
}
