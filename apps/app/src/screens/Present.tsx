// Sharing a proof: consent screen -> verifying -> result.
// Everything shown comes from the signed request, the registry, the stored credential and the verifier's reply.
import { useEffect, useState } from 'react';
import { CLAIM_LABELS, SENSITIVE_CLAIMS, templateLabel } from '@true/shared';
import type { RequestCheck } from '@true/credentials';
import { answerRequest, loadRequest, matchingCredentials, pickCredential, recordBlocked, type Answer } from '@true/wallet-core';
import { Avatar, Badge, Card, ConsentRow, Field, Orb, PillButton, Screen, StepList, TopBar, go, type StepItem } from '../ui.tsx';
import { STEP_LABELS, browserFetch, cardFields, registry, useCards } from '../wallet.ts';

export function Present({ requestUri }: { requestUri: string }) {
  const { cards } = useCards();
  const [check, setCheck] = useState<RequestCheck | null>(null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [revealed, setRevealed] = useState(0); // how many check lines are shown so far
  const [showResult, setShowResult] = useState(false);

  // Who is really asking? The request's signature is checked against the key registered on the chain.
  useEffect(() => {
    loadRequest({ requestUri, fetch: browserFetch, getVerifier: (id) => registry.getVerifier(id) })
      .then(setCheck)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the request'));
  }, [requestUri]);

  // The verifier answers in one go. We then show its check lines one at a time so they can be read,
  // and move on to the result. The results are real; only the pacing is for the eye.
  useEffect(() => {
    if (!answer || showResult) return;
    if (answer.steps.length === 0) return setShowResult(true); // declined or refused before any checks ran
    const timer = setTimeout(() => (revealed < answer.steps.length ? setRevealed(revealed + 1) : setShowResult(true)), revealed < answer.steps.length ? 380 : 700);
    return () => clearTimeout(timer);
  }, [answer, revealed, showResult]);

  // The card that can answer this request: it must hold every requested field.
  // If none does, fall back to the newest card so the screen can still explain what is asked.
  const dated = (cards ?? []).map((c) => ({ ...c, addedAt: c.stored.addedAt, issuerId: c.stored.issuerId }));
  // A register is pinned to ONE institution and ONE ID type: only such a card is offered.
  const pin = check?.status === 'verified' ? check.request.register : undefined;
  const matching = check?.status === 'verified' ? matchingCredentials(dated, check.request.claims, pin && { issuer: pin.issuerId, type: pin.type }) : [];
  const card = matching[0] ?? (pin ? undefined : pickCredential(dated));

  async function respond(approve: boolean) {
    if (!check || check.status !== 'verified' || !card) return;
    setSending(true);
    try {
      setAnswer(await answerRequest({ check, stored: card.stored, approve, fetch: browserFetch }));
    } catch {
      setError('Could not reach the verifier. Nothing was confirmed.');
    }
  }

  if (error) {
    return (
      <Screen>
        <TopBar back="/home" />
        <Card tone="bad"><div className="font-semibold text-bad">Could not continue</div><p className="mt-1 text-small">{error}</p></Card>
        <div className="mt-4"><PillButton kind="secondary" onClick={() => go('/home')}>Back to wallet</PillButton></div>
      </Screen>
    );
  }
  if (!check || cards === null) return <Screen><TopBar back="/home" /><p className="text-small text-muted">Checking who is asking…</p></Screen>;

  // ---------- blocked: unregistered verifier, or a request that was changed ----------
  if (check.status !== 'verified') {
    const unregistered = check.status === 'unregistered';
    return (
      <Screen>
        <TopBar back="/home" />
        <Card tone="bad">
          <div className="text-lg font-bold text-bad">{unregistered ? 'Unregistered verifier' : 'This request was tampered with'}</div>
          <p className="mt-2 text-small">
            {unregistered
              ? <>This request says it comes from <b>{check.claimedBy}</b>, but nobody with that id is in the verifier registry. It may be a phishing attempt.</>
              : <>This request uses the id <b>{check.claimedBy}</b>, but its signature does not match the key registered for that verifier.</>}
          </p>
          <p className="mt-2 text-small font-semibold">Sharing is blocked. Nothing has been sent.</p>
        </Card>
        <div className="mt-4"><PillButton onClick={() => recordBlocked(check.claimedBy, check.status).then(() => go('/home'))}>Close</PillButton></div>
      </Screen>
    );
  }

  const { request, verifierName, extraClaims } = check;

  // ---------- result ----------
  if (answer && showResult) return <Result answer={answer} verifierName={verifierName} claims={card?.claims ?? {}} />;

  // ---------- verifying ----------
  if (sending) {
    const steps: StepItem[] = answer
      ? answer.steps.map((step, i) => ({ label: STEP_LABELS[step.name] ?? step.name, status: i < revealed ? step.status : i === revealed ? 'running' : 'waiting' }))
      : Object.values(STEP_LABELS).map((label, i) => ({ label, status: i === 0 ? 'running' : 'waiting' }));
    return (
      <Screen>
        <div className="pt-10 text-center text-lg font-semibold">Verifying…</div>
        <div className="py-10"><Orb state="working" /></div>
        <StepList steps={steps} />
        <p className="mt-8 text-center text-small text-muted">{verifierName} is checking your proof.</p>
      </Screen>
    );
  }

  // ---------- consent ----------
  if (!card && pin) {
    return (
      <Screen>
        <TopBar back="/home" />
        <Card tone="warn">
          <div className="font-semibold">You don't have the required ID from {pin.issuerName}</div>
          <p className="mt-1 text-small">"{pin.name}" (by {pin.owner}) accepts only a {templateLabel(pin.type)} from {pin.issuerName}. Nothing was shared.</p>
        </Card>
        <div className="mt-4"><PillButton kind="secondary" onClick={() => go('/home')}>Back to wallet</PillButton></div>
      </Screen>
    );
  }
  if (!card) {
    return (
      <Screen>
        <TopBar back="/home" />
        <Card><div className="font-semibold">No credential in this wallet</div><p className="mt-1 text-small text-muted">{verifierName} is asking for a proof, but you have nothing to share yet.</p></Card>
        <div className="mt-4"><PillButton onClick={() => go('/offers')}>See my offers</PillButton></div>
      </Screen>
    );
  }
  const overAsking = extraClaims.length > 0;
  const notRequested = cardFields(card.claims).filter((name) => !request.claims.includes(name));

  return (
    <Screen>
      <TopBar back="/home" />
      <h1 className="text-title font-bold leading-tight">Review what you'll share</h1>
      <p className="mt-2 mb-5 text-muted">Only the ticked information will be included in your proof.</p>

      <Card className="mb-5">
        <div className="flex items-center gap-3">
          <Avatar name={pin?.name ?? verifierName} size={52} />
          <div className="min-w-0">
            <div className="font-semibold">{pin?.name ?? verifierName}</div>
            {pin && <div className="text-small">Register owned by <b>{pin.owner}</b></div>}
            <div className="text-small text-muted">{request.purpose}</div>
            <div className="mt-1"><Badge tone="ok">{pin ? 'Signed by the registered TRUE register service' : 'Registered verifier'}</Badge></div>
          </div>
        </div>
        {pin && (
          <div className="mt-3 rounded-row bg-soft px-3">
            <Field label="Accepts only">{templateLabel(pin.type)}</Field>
            <Field label="From">{pin.issuerName}</Field>
            <Field label="Your card">{templateLabel(card.type)} · {card.stored.id}</Field>
          </div>
        )}
        {pin && (
          <p className="mt-3 rounded-row bg-warn-soft p-2 text-small text-warn">
            <b>{pin.owner} will keep these details in this register's visitor list</b>{pin.retentionDays ? ` for ${pin.retentionDays} days` : ''}. Only they can see it.
          </p>
        )}
      </Card>

      {request.claims.some((name) => SENSITIVE_CLAIMS.includes(name)) && (
        <Card tone="warn" className="mb-4">
          <div className="font-semibold text-warn">Sensitive information requested</div>
          <p className="mt-1 text-small">
            This asks for: <b>{request.claims.filter((name) => SENSITIVE_CLAIMS.includes(name)).map((name) => CLAIM_LABELS[name] ?? name).join(', ')}</b>.
            Share only if you know and trust who is asking.
          </p>
        </Card>
      )}

      {card.stored.revoked && (
        <Card tone="bad" className="mb-4">
          <div className="font-semibold text-bad">Your credential was revoked</div>
          <p className="mt-1 text-small">This verifier will refuse it. Ask the institution to issue a new one.</p>
        </Card>
      )}

      {overAsking && (
        <Card tone="warn" className="mb-4">
          <div className="font-semibold text-warn">Asking for more than it is registered for</div>
          <p className="mt-1 text-small">
            {verifierName} is registered to ask only for its stated purpose. It is not allowed to ask for:{' '}
            <b>{extraClaims.map((name) => CLAIM_LABELS[name] ?? name).join(', ')}</b>. Sharing is turned off for this request.
          </p>
        </Card>
      )}

      <h2 className="mb-2 font-semibold">Information to share</h2>
      <div className="mb-5 space-y-2">
        {request.claims.map((name) => {
          const extra = extraClaims.includes(name);
          return (
            <ConsentRow
              key={name} label={CLAIM_LABELS[name] ?? name} locked checked={!overAsking}
              tone={extra || SENSITIVE_CLAIMS.includes(name) ? 'warn' : 'plain'}
              description={extra ? 'Not registered for this verifier' : SENSITIVE_CLAIMS.includes(name) ? 'Sensitive: share only if you trust this verifier' : 'Requested by this verifier'}
            />
          );
        })}
      </div>

      <h2 className="mb-2 font-semibold">Not required</h2>
      <div className="mb-5 space-y-2">
        {notRequested.map((name) => (
          <ConsentRow key={name} label={CLAIM_LABELS[name] ?? name} description="Not required for this proof. Stays on this device." checked={false} locked />
        ))}
      </div>

      <Card tone="plain" className="mb-5 bg-accent-soft">
        <p className="text-small">
          The ticked items are required by this verifier, so they cannot be unticked one by one: share them all or decline.
          Nothing else leaves this device.
        </p>
      </Card>

      <div className="space-y-3">
        <PillButton onClick={() => respond(true)} disabled={overAsking}>Share proof</PillButton>
        <PillButton kind="secondary" onClick={() => respond(false)}>Decline</PillButton>
      </div>
    </Screen>
  );
}

// What each reason code means, in plain words.
const REASONS: Record<string, string> = {
  user_declined: 'You declined. Nothing was shared.',
  revoked: 'The issuer has revoked this credential.',
  issuer_key_compromised: 'The issuer marked the key that signed this credential as compromised. Ask the issuer for a new credential.',
  unknown_issuer: 'The key that signed this credential is not in the registry.',
  requirement_not_met: 'Your credential is genuine, but it answers "No" to what was asked.',
  missing_claims: 'A requested item was not included.',
  request_already_answered: 'This request was already answered. Ask the verifier for a new QR code.',
  request_expired: 'This request has expired. Ask the verifier for a new QR code.',
  too_many_attempts: 'Too many failed attempts. Wait a moment and try again.',
  no_server_available: 'The verifier is not reachable right now.',
};

function Result({ answer, verifierName, claims }: { answer: Answer; verifierName: string; claims: Record<string, unknown> }) {
  const [details, setDetails] = useState(false);
  const verified = answer.state === 'verified';
  const declined = answer.code === 'user_declined';
  return (
    <Screen>
      <div className="pt-8"><Orb state={verified ? 'ok' : 'bad'} /></div>
      <h1 className={`mt-5 text-center text-3xl font-bold ${verified ? 'text-ok' : declined ? 'text-ink' : 'text-bad'}`}>{verified ? 'Verified' : declined ? 'Declined' : 'Denied'}</h1>
      <p className="mt-2 mb-6 text-center text-muted">
        {verified ? `${verifierName} accepted your proof.` : REASONS[answer.code ?? ''] ?? answer.message ?? 'The verifier did not accept this proof.'}
      </p>

      {!verified && !declined && answer.code && (
        <Card tone="bad" className="mb-4">
          <Field label="Reason code">{answer.code}</Field>
          {answer.message && <Field label="Verifier said">{answer.message}</Field>}
        </Card>
      )}

      <Card className="mb-4">
        <div className="mb-1 font-semibold">{answer.decision === 'shared' ? `Sent to ${verifierName}` : 'Nothing was shared'}</div>
        {answer.sharedClaims.map((name) => <Field key={name} label={CLAIM_LABELS[name] ?? name}>{String(claims[name] ?? '')}</Field>)}
      </Card>

      {answer.steps.length > 0 && (
        <Card className="mb-4">
          <div className="mb-3 font-semibold">Checks by {verifierName}</div>
          <StepList steps={answer.steps.map((step) => ({ label: STEP_LABELS[step.name] ?? step.name, status: step.status }))} />
        </Card>
      )}

      <Card className="mb-6">
        <button onClick={() => setDetails(!details)} className="flex w-full items-center justify-between font-semibold">
          Cryptographic details <span className="text-muted">{details ? '▴' : '▾'}</span>
        </button>
        {details && (
          <div className="mt-2">
            <Field label="Issuer">{answer.issuer ?? 'not reported'}</Field>
            <Field label="Issuer key id">{answer.keyId ?? 'not reported'}</Field>
            <Field label="Status">{verified ? 'Valid' : answer.code ?? answer.state}</Field>
            <Field label="Verified at">{answer.verifiedAt ? new Date(answer.verifiedAt).toLocaleString() : 'not reported'}</Field>
            <Field label="Answered by">{answer.servedBy ?? 'not reported'}</Field>
          </div>
        )}
      </Card>

      <PillButton onClick={() => go('/home')}>Done</PillButton>
    </Screen>
  );
}
