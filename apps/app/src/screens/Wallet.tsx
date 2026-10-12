// Person: the wallet (home) and the credential detail screen.
import { useState } from 'react';
import { CLAIM_LABELS, templateLabel } from '@true/shared';
import { removeCredential } from '@true/wallet-core';
import { Avatar, Badge, BottomTabs, Card, Field, PillButton, Screen, TopBar, go } from '../ui.tsx';
import { useSession } from '../session.ts';
import { cardFields, cardStatus, formatDate, useCards, type CardView } from '../wallet.ts';

// "Good morning" / "afternoon" / "evening" from the device clock.
function greeting(): string {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

// The institution's name comes from the registry when it can be read, else from what the card was issued with.
const institutionName = (card: CardView) => card.issuer?.name ?? card.stored.issuerName;

// "Verified institution" / "Unverified institution", read from the chain registry.
export function InstitutionBadge({ verified }: { verified: boolean | undefined }) {
  if (verified === undefined) return <Badge>Registry not reachable</Badge>;
  return verified ? <Badge tone="ok">Verified institution</Badge> : <Badge tone="warn">Unverified institution</Badge>;
}

export function Home() {
  const session = useSession()!;
  const { cards } = useCards();
  return (
    <Screen tabs={<BottomTabs active="/home" />}>
      <div className="mb-6 flex items-center gap-3">
        <button onClick={() => go('/profile')} aria-label="Profile"><Avatar name={session.account.name} /></button>
        <div>
          <div className="text-small text-muted">{greeting()},</div>
          <div className="text-xl font-semibold">{session.account.name.split(' ')[0]}</div>
        </div>
      </div>

      <Card tone="dark" onClick={() => go('/scan')} className="mb-6">
        <div className="font-semibold">Asked to prove something?</div>
        <div className="text-small text-white/70">Scan the checker's QR code. You choose what is shared.</div>
      </Card>

      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Your IDs</h2>
        {cards && <span className="text-small text-muted">{cards.length}</span>}
      </div>
      <div className="space-y-3">
        {cards === null && <p className="text-small text-muted">Loading…</p>}
        {cards?.length === 0 && (
          <Card>
            <div className="font-semibold">No IDs yet</div>
            <p className="mt-1 text-small text-muted">When an institution issues you an ID it appears under Offers. Accept it and the card lands here.</p>
          </Card>
        )}
        {cards?.map((card) => {
          const status = cardStatus(card);
          return (
            <Card key={card.stored.id} onClick={() => go(`/credential?id=${card.stored.id}`)}>
              <div className="flex items-center gap-3">
                <Avatar name={institutionName(card)} />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{templateLabel(card.type)}</div>
                  <div className="truncate text-small text-muted">{institutionName(card)}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <Badge tone={status.tone}>{status.label}</Badge>
                    {card.check && <span className="text-small text-muted">valid till {formatDate(card.check.expiresAt)}</span>}
                  </div>
                </div>
                <span className="text-muted">›</span>
              </div>
            </Card>
          );
        })}
      </div>
      <div className="mt-5"><PillButton kind="secondary" onClick={() => go('/offers')}>See offers</PillButton></div>
    </Screen>
  );
}

export function CredentialDetail({ id }: { id: string }) {
  const { cards } = useCards();
  const [confirmRemove, setConfirmRemove] = useState(false);
  if (cards === null) return <Screen><TopBar back="/home" /><p className="text-small text-muted">Loading…</p></Screen>;
  const card = cards.find((c) => c.stored.id === id);
  if (!card) return <Screen><TopBar back="/home" /><Card>This ID is no longer in the wallet.</Card></Screen>;
  const status = cardStatus(card);

  return (
    <Screen>
      <TopBar back="/home" />
      <div className="mb-5 flex items-center gap-3">
        <Avatar name={institutionName(card)} size={52} />
        <div>
          <div className="text-xl font-semibold">{templateLabel(card.type)}</div>
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
      </div>

      {card.stored.revoked && (
        <Card tone="bad" className="mb-4">
          <div className="font-semibold text-bad">Revoked by the institution</div>
          <p className="mt-1 text-small">A revoked ID can never work again. Ask the institution to issue a new one.</p>
        </Card>
      )}

      {/* The card face: initials only, never a photo. */}
      <Card tone="dark" className="mb-4">
        <div className="text-tiny uppercase tracking-widest text-white/60">{institutionName(card)}</div>
        <div className="mt-4 flex items-center gap-3">
          <Avatar name={String(card.claims.name ?? '')} size={48} />
          <div>
            <div className="text-lg font-semibold">{String(card.claims.name ?? '')}</div>
            <div className="text-small text-white/70">{templateLabel(card.type)} · {card.stored.id}</div>
          </div>
        </div>
      </Card>

      <Card className="mb-4">
        <Field label="Issued by">{institutionName(card)}</Field>
        <Field label="Institution"><InstitutionBadge verified={card.issuer?.verified} /></Field>
        {card.check && <Field label="Issued on">{formatDate(card.check.issuedAt)}</Field>}
        {card.check && <Field label="Valid till">{formatDate(card.check.expiresAt)}</Field>}
        {card.check && <Field label="Signed with key">{card.check.keyId}</Field>}
        <Field label="Institution's signature">{!card.check ? 'Not checked (registry not reachable)' : card.check.status === 'verified' ? 'Valid against the chain registry' : 'Not valid'}</Field>
      </Card>

      <h2 className="mb-2 font-semibold">Fields in this ID</h2>
      <Card className="mb-3">
        {cardFields(card.claims).map((name) => <Field key={name} label={CLAIM_LABELS[name] ?? name}>{String(card.claims[name])}</Field>)}
      </Card>
      <p className="mb-4 text-small text-muted">These stay on this device. A checker only ever receives the fields you approve for one request.</p>

      <div className="space-y-3">
        <PillButton onClick={() => go('/scan')}>Share specific info</PillButton>
        {confirmRemove
          ? <PillButton kind="danger" onClick={() => removeCredential(card.stored.id).then(() => go('/home'))}>Yes, remove from this device</PillButton>
          : <PillButton kind="secondary" onClick={() => setConfirmRemove(true)}>Remove from wallet</PillButton>}
      </div>
    </Screen>
  );
}
