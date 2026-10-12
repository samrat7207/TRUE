// Home / Wallet, the credential detail screen, and "Claim credential".
import { useState } from 'react';
import { ALL_CLAIMS, CLAIM_LABELS } from '@true/shared';
import { claimCredential, parseScanned, removeCredential } from '@true/wallet-core';
import { Avatar, Badge, BottomTabs, Card, Field, PillButton, Screen, TopBar, go } from '../ui.tsx';
import {
  TYPE_LABELS, browserFetch, cardStatus, displayValue, formatDate, issuerApiAddress, useCards, useHolderName, type CardView,
} from '../wallet.ts';

// "Good morning" / "afternoon" / "evening" from the device clock.
function greeting(): string {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

export function Home() {
  const { cards } = useCards();
  const name = useHolderName(cards);
  const firstName = name.split(' ')[0];

  return (
    <Screen tabs={<BottomTabs active="/home" />}>
      <div className="mb-6 flex items-center gap-3">
        <button onClick={() => go('/profile')} aria-label="Profile"><Avatar name={name || 'You'} /></button>
        <div>
          <div className="text-small text-muted">{greeting()},</div>
          <div className="text-xl font-semibold">{firstName || 'welcome'}</div>
        </div>
      </div>

      <Card tone="dark" onClick={() => go('/scan')} className="mb-6">
        <div className="font-semibold">Asked to prove something?</div>
        <div className="text-small text-white/70">Scan the verifier's QR code. You choose what is shared.</div>
      </Card>

      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Your credentials</h2>
        {cards && <span className="text-small text-muted">{cards.length}</span>}
      </div>

      <div className="space-y-3">
        {cards === null && <p className="text-small text-muted">Loading…</p>}
        {cards?.length === 0 && (
          <Card>
            <div className="font-semibold">No credentials yet</div>
            <p className="mt-1 text-small text-muted">Ask your institution for a claim code or offer link, then add it below.</p>
          </Card>
        )}
        {cards?.map((card) => <CredentialRow key={card.stored.id} card={card} />)}
      </div>

      <div className="mt-5"><PillButton onClick={() => go('/claim')}>+ Claim credential</PillButton></div>
    </Screen>
  );
}

function CredentialRow({ card }: { card: CardView }) {
  const status = cardStatus(card);
  return (
    <Card onClick={() => go(`/credential?id=${card.stored.id}`)}>
      <div className="flex items-center gap-3">
        <Avatar name={card.stored.issuerName} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{TYPE_LABELS[String(card.claims.vct)] ?? 'Credential'}</div>
          <div className="truncate text-small text-muted">{card.stored.issuerName}</div>
          <div className="mt-1 flex items-center gap-2">
            <Badge tone={status.tone}>{status.label}</Badge>
            {card.check && <span className="text-small text-muted">valid till {formatDate(card.check.expiresAt)}</span>}
          </div>
        </div>
        <span className="text-muted">›</span>
      </div>
    </Card>
  );
}

// ---------- credential detail ----------

export function CredentialDetail({ id }: { id: string }) {
  const { cards } = useCards();
  const [confirmRemove, setConfirmRemove] = useState(false);
  if (cards === null) return <Screen><TopBar back="/home" /><p className="text-small text-muted">Loading…</p></Screen>;
  const card = cards.find((c) => c.stored.id === id);
  if (!card) return <Screen><TopBar back="/home" /><Card>This credential is no longer in the wallet.</Card></Screen>;
  const status = cardStatus(card);

  return (
    <Screen>
      <TopBar back="/home" />
      <div className="mb-5 flex items-center gap-3">
        <Avatar name={card.stored.issuerName} size={52} />
        <div>
          <div className="text-xl font-semibold">{TYPE_LABELS[String(card.claims.vct)] ?? 'Credential'}</div>
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
      </div>

      {card.stored.revoked && (
        <Card tone="bad" className="mb-4">
          <div className="font-semibold text-bad">Revoked by the issuer</div>
          <p className="mt-1 text-small">A revoked card can never work again. If the issuer has given your credential back, claim the new one; it replaces this card.</p>
        </Card>
      )}

      {/* The card face: initials only, never a photo. */}
      <Card tone="dark" className="mb-4">
        <div className="text-tiny uppercase tracking-widest text-white/60">{card.stored.issuerName}</div>
        <div className="mt-4 flex items-center gap-3">
          <Avatar name={String(card.claims.name ?? '')} size={48} />
          <div>
            <div className="text-lg font-semibold">{String(card.claims.name ?? '')}</div>
            <div className="text-small text-white/70">{String(card.claims.pnr ?? '')}</div>
          </div>
        </div>
      </Card>

      <Card className="mb-4">
        <Field label="Issued by">{card.stored.issuerName}</Field>
        {card.check && <Field label="Issued on">{formatDate(card.check.issuedAt)}</Field>}
        {card.check && <Field label="Valid till">{formatDate(card.check.expiresAt)}</Field>}
        {card.check && <Field label="Issuer key">{card.check.keyId}</Field>}
        <Field label="Added to wallet">{new Date(card.stored.addedAt).toLocaleString()}</Field>
      </Card>

      <h2 className="mb-2 font-semibold">Claims in this credential</h2>
      <Card className="mb-5">
        {ALL_CLAIMS.filter((name) => name in card.claims).map((name) => (
          <Field key={name} label={CLAIM_LABELS[name] ?? name}>{displayValue(name, card.claims[name])}</Field>
        ))}
      </Card>
      <p className="mb-4 text-small text-muted">These stay on this device. A verifier only ever receives the items you approve for one request.</p>

      <div className="space-y-3">
        <PillButton onClick={() => go('/scan')}>Share specific info</PillButton>
        {confirmRemove
          ? <PillButton kind="danger" onClick={() => removeCredential(card.stored.id).then(() => go('/home'))}>Yes, remove this credential</PillButton>
          : <PillButton kind="secondary" onClick={() => setConfirmRemove(true)}>Remove from wallet</PillButton>}
      </div>
    </Screen>
  );
}

// ---------- claim ----------

// Add a credential with the issuer's offer link or one-time code. There is no way to type credential data in.
export function Claim({ initial }: { initial: string }) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function claim() {
    const scanned = parseScanned(text);
    if (scanned.kind !== 'claim') return setError('That is not a claim code or an offer link.');
    setBusy(true);
    setError('');
    try {
      await claimCredential({ code: scanned.code, issuerApi: await issuerApiAddress(), fetch: browserFetch });
      go('/home');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
      setBusy(false);
    }
  }

  return (
    <Screen>
      <TopBar back="/home" />
      <h1 className="text-title font-bold leading-tight">Claim a credential</h1>
      <p className="mt-2 mb-5 text-muted">Paste the offer link or type the one-time claim code from your institution. Only the issuer can create a credential.</p>
      <input
        value={text} onChange={(e) => setText(e.target.value)} placeholder="Claim code or offer link" autoFocus
        className="mb-3 w-full rounded-row border border-line bg-surface px-4 py-3.5 font-mono"
      />
      {error && <Card tone="bad" className="mb-3"><span className="text-small text-bad">Refused: {error}</span></Card>}
      <PillButton onClick={claim} disabled={busy || !text.trim()}>{busy ? 'Claiming…' : 'Add to wallet'}</PillButton>
    </Screen>
  );
}
