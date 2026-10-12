// Person: offers from institutions. Accept puts the ID in the wallet; Reject tells the institution no.
import { useEffect, useState } from 'react';
import { CLAIM_LABELS, templateLabel } from '@true/shared';
import { acceptOffer, getOffers, rejectOffer, type Offer } from '@true/wallet-core';
import { Avatar, BottomTabs, Card, Field, PillButton, Screen, go } from '../ui.tsx';
import { walletApi } from '../session.ts';
import { registry } from '../wallet.ts';
import { InstitutionBadge } from './Wallet.tsx';

export function Offers() {
  const [offers, setOffers] = useState<Offer[] | null>(null);
  // Whether each institution is verified, read from the chain registry (not taken from the server's word).
  const [verified, setVerified] = useState<Record<string, boolean | undefined>>({});
  const [open, setOpen] = useState(''); // offer whose fields are shown
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  async function refresh() {
    const list = await getOffers(walletApi()).catch(() => null);
    if (!list) return;
    setOffers(list);
    for (const offer of list) {
      registry.getIssuer(offer.institution.id)
        .then((issuer) => setVerified((known) => ({ ...known, [offer.institution.id]: issuer?.verified ?? false })))
        .catch(() => {});
    }
  }
  // New offers appear within a few seconds while this tab is open.
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, []);

  // Accept: the key is made on this device, the institution signs an ID bound to it, and the card lands in the wallet.
  async function accept(offer: Offer) {
    setBusy(offer.id);
    setError('');
    try {
      await acceptOffer(walletApi(), offer.id);
      go('/home');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not accept');
      setBusy('');
    }
  }
  async function reject(offer: Offer) {
    setError('');
    await rejectOffer(walletApi(), offer.id).catch((e) => setError(e.message));
    refresh();
  }

  return (
    <Screen tabs={<BottomTabs active="/offers" />}>
      <h1 className="text-title font-bold leading-tight">Offers</h1>
      <p className="mt-2 mb-5 text-muted">IDs that institutions want to give you.</p>
      {error && <Card tone="bad" className="mb-3"><span className="text-small text-bad">{error}</span></Card>}
      <div className="space-y-3">
        {offers === null && <p className="text-small text-muted">Loading…</p>}
        {offers?.length === 0 && <Card><span className="text-small text-muted">No offers waiting. New ones appear here within a few seconds.</span></Card>}
        {offers?.map((offer) => (
          <Card key={offer.id}>
            <div className="flex items-start gap-3">
              <Avatar name={offer.institution.name} />
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{offer.institution.name}</div>
                <InstitutionBadge verified={verified[offer.institution.id]} />
                <div className="mt-1 text-small">wants to give you a <b>{templateLabel(offer.template)}</b></div>
                <div className="text-tiny text-muted">{offer.id} · {new Date(offer.createdAt).toLocaleString()}</div>
              </div>
            </div>
            {verified[offer.institution.id] === false && (
              <p className="mt-3 rounded-row bg-warn-soft p-2 text-small text-warn">This institution has not been verified. Only accept if you know who it is.</p>
            )}
            <button onClick={() => setOpen(open === offer.id ? '' : offer.id)} className="mt-3 text-small underline">{open === offer.id ? 'Hide' : 'See'} what it contains</button>
            {open === offer.id && (
              <div className="mt-2 rounded-row bg-soft px-3">
                {Object.entries(offer.fields).map(([name, value]) => <Field key={name} label={CLAIM_LABELS[name] ?? name}>{value}</Field>)}
              </div>
            )}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <PillButton kind="secondary" onClick={() => reject(offer)} disabled={busy === offer.id}>Reject</PillButton>
              <PillButton onClick={() => accept(offer)} disabled={busy === offer.id}>{busy === offer.id ? 'Adding…' : 'Accept'}</PillButton>
            </div>
          </Card>
        ))}
      </div>
    </Screen>
  );
}
