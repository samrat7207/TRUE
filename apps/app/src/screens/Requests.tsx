// Requests tab: offers the institute made to you, and requests you sent to the institute.
import { useEffect, useState } from 'react';
import { CREDENTIAL_TYPES, ISSUER_NAME } from '@true/shared';
import {
  acceptInboxOffer, declineInboxOffer, getInboxOffers, getMyRequests, linkInstituteRecord, refreshCredentialRequests,
  saveInboxLink, submitCredentialRequest, type InboxLink, type InboxOffer, type MyRequest,
} from '@true/wallet-core';
import { Badge, BottomTabs, Card, PillButton, Screen, go } from '../ui.tsx';
import { browserFetch, issuerApiAddress } from '../wallet.ts';

const TONE = { pending: 'warn', approved: 'ok', rejected: 'bad' } as const;
const LABEL = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected' };

// Ask the issuer about pending requests; an approved one is collected into the wallet automatically.
export const checkMyRequests = async () => refreshCredentialRequests({ issuerApi: await issuerApiAddress(), fetch: browserFetch });

export function Requests() {
  const [requests, setRequests] = useState<MyRequest[]>([]);
  const [link, setLink] = useState<InboxLink | undefined>();
  const [offers, setOffers] = useState<InboxOffer[]>([]);
  const [message, setMessage] = useState('');

  // Everything on this tab is refreshed every 3 seconds while it is open.
  async function refresh() {
    const inbox = await getInboxOffers({ issuerApi: await issuerApiAddress(), fetch: browserFetch });
    setLink(inbox.link);
    setOffers(inbox.offers);
    setRequests(await checkMyRequests().catch(() => getMyRequests()));
  }
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, []);

  // Accept runs the normal claim flow: the key is made on this device and the card lands in the wallet.
  async function accept(offer: InboxOffer) {
    setMessage('');
    try {
      await acceptInboxOffer({ offerId: offer.id, issuerApi: await issuerApiAddress(), fetch: browserFetch });
      go('/home');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not accept the offer');
    }
  }
  async function decline(offer: InboxOffer) {
    setMessage('');
    await declineInboxOffer({ offerId: offer.id, issuerApi: await issuerApiAddress(), fetch: browserFetch }).catch((e) => setMessage(e.message));
    refresh();
  }

  return (
    <Screen tabs={<BottomTabs active="/requests" />}>
      <h1 className="text-title font-bold leading-tight">Requests</h1>
      <p className="mt-2 mb-5 text-muted">Credentials {ISSUER_NAME} is offering you, and credentials you asked for.</p>

      {/* ---------- offers from the institute ---------- */}
      <h2 className="mb-2 text-lg font-semibold">Offers for you</h2>
      {!link
        ? <LinkForm onLinked={refresh} />
        : (
          <div className="mb-6 space-y-2">
            <Card className="bg-accent-soft">
              <div className="flex items-center justify-between gap-2">
                <span className="text-small">Linked to <b>{link.pnr}</b> at {link.issuerName} until {new Date(link.expiresAt).toLocaleString()}</span>
                <button onClick={() => saveInboxLink(undefined).then(refresh)} className="shrink-0 text-small underline">Unlink</button>
              </div>
            </Card>
            {offers.length === 0 && <Card><span className="text-small text-muted">No offers waiting. New ones appear here within a few seconds.</span></Card>}
            {offers.map((offer) => (
              <Card key={offer.id}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold">{CREDENTIAL_TYPES[offer.type]} from {link.issuerName}</div>
                    <div className="text-tiny text-muted">{offer.id} · offered {new Date(offer.createdAt).toLocaleString()}</div>
                  </div>
                  <Badge tone="warn">Pending</Badge>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <PillButton kind="secondary" onClick={() => decline(offer)}>Decline</PillButton>
                  <PillButton onClick={() => accept(offer)}>Accept</PillButton>
                </div>
              </Card>
            ))}
            {message && <Card tone="bad"><span className="text-small text-bad">{message}</span></Card>}
          </div>
        )}

      {/* ---------- requests the holder sends ---------- */}
      <h2 className="mb-2 text-lg font-semibold">Ask for a credential</h2>
      <RequestForm onSent={refresh} />

      <h2 className="mb-2 text-lg font-semibold">Your requests</h2>
      <div className="space-y-2">
        {requests.length === 0 && <Card><span className="text-small text-muted">You have not asked for anything yet.</span></Card>}
        {requests.map((request) => (
          <Card key={request.id}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-semibold">{CREDENTIAL_TYPES[request.type]}</div>
                <div className="text-small text-muted">{ISSUER_NAME} · {request.pnr}</div>
                <div className="text-tiny text-muted">{new Date(request.createdAt).toLocaleString()}</div>
                {request.note && <div className="mt-1 text-small">{request.note}</div>}
              </div>
              <Badge tone={TONE[request.status]}>{LABEL[request.status]}</Badge>
            </div>
          </Card>
        ))}
      </div>
    </Screen>
  );
}

const INPUT = 'mt-1 w-full rounded-row border border-line bg-surface px-3 py-3 font-normal';

// "Link my institute record": prove which student you are, once, so offers can find this phone.
function LinkForm({ onLinked }: { onLinked: () => void }) {
  const [pnr, setPnr] = useState('');
  const [dob, setDob] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function link() {
    setBusy(true);
    setError('');
    try {
      await linkInstituteRecord({ pnr, dob, issuerApi: await issuerApiAddress(), fetch: browserFetch });
      onLinked();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not link');
    }
    setBusy(false);
  }

  return (
    <Card className="mb-6">
      <div className="font-semibold">Link my institute record</div>
      <p className="mt-1 text-small text-muted">
        Enter your PNR and date of birth once. Credentials {ISSUER_NAME} issues to you will then show up here to accept.
        The link lasts 24 hours; your date of birth is not kept on this device.
      </p>
      <label className="mt-3 block text-small font-semibold">PNR (student number)
        <input value={pnr} onChange={(e) => setPnr(e.target.value)} placeholder="e.g. AIT2023005" className={INPUT + ' font-mono uppercase'} />
      </label>
      <label className="mt-3 block text-small font-semibold">Date of birth
        <input type="date" value={dob} onChange={(e) => setDob(e.target.value)} className={INPUT} />
      </label>
      <div className="mt-4"><PillButton onClick={link} disabled={busy || pnr.trim().length < 3 || !dob}>{busy ? 'Checking…' : 'Link my record'}</PillButton></div>
      {error && <p className="mt-2 text-small text-bad">{error}</p>}
      <p className="mt-3 text-tiny text-muted">Demo limit: a PNR and a date of birth are weak proof of who you are. A real institute would use a proper sign-in.</p>
    </Card>
  );
}

function RequestForm({ onSent }: { onSent: () => void }) {
  const [type, setType] = useState('StudentCredential');
  const [pnr, setPnr] = useState('');
  const [dob, setDob] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await submitCredentialRequest({ type, pnr, dob, issuerApi: await issuerApiAddress(), fetch: browserFetch });
      setPnr('');
      setDob('');
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the request');
    }
    setBusy(false);
  }

  return (
    <Card className="mb-6">
      <label className="block text-small font-semibold">Credential type
        <select value={type} onChange={(e) => setType(e.target.value)} className={INPUT}>
          {Object.entries(CREDENTIAL_TYPES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label className="mt-3 block text-small font-semibold">PNR (student number)
        <input value={pnr} onChange={(e) => setPnr(e.target.value)} placeholder="e.g. AIT2023002" className={INPUT + ' font-mono uppercase'} />
      </label>
      <label className="mt-3 block text-small font-semibold">Date of birth
        <input type="date" value={dob} onChange={(e) => setDob(e.target.value)} className={INPUT} />
      </label>
      <div className="mt-4"><PillButton onClick={submit} disabled={busy || pnr.trim().length < 3 || !dob}>{busy ? 'Sending…' : 'Send request'}</PillButton></div>
      {error && <p className="mt-2 text-small text-bad">{error}</p>}
      <p className="mt-3 text-tiny text-muted">Demo limit: this is not real identity proofing. Staff approve or reject; use the fake demo students only.</p>
    </Card>
  );
}
