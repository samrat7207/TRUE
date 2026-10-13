// Control Room: the laptop's view of the demo. Sidebar, servers, live activity, load test, set-up,
// and on the right a phone frame that shows the normal phone app (it is the "third phone").
// This file never reads or writes the wallet: the phone app inside the frame does that by itself.
import { useState } from 'react';
import { BRAND } from '@true/shared';
import { Blob as ChromeBlob, Card, QrPanel } from '../ui.tsx';
import { ActivityLog } from './ActivityLog.tsx';
import { Servers } from './Servers.tsx';
import { FRONT_DOOR, Section, SmallButton, getJson, useEvery } from './parts.tsx';

type Network = { name: string; address: string }; // one network adapter of the laptop
const TAGLINE = 'Identity Without Exposure.';
const NAV = [
  { id: 'servers', label: 'Servers', icon: 'M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01' },
  { id: 'activity', label: 'Activity', icon: 'M5 4h14v16H5zM9 8h6M9 12h6M9 16h3' },
  { id: 'load-test', label: 'Load test', icon: 'M4 20V10M10 20V4M16 20v-7M21 20H3' },
  { id: 'setup', label: 'Setup', icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1l2-1.6-2-3.4-2.4 1a7 7 0 0 0-1.7-1L14.5 3h-5l-.3 3a7 7 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 1.7 1l.3 3h5l.3-3a7 7 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6a7 7 0 0 0 .1-1z' },
];

export function ControlRoom() {
  // The laptop's addresses on the local network: what to type as "Server address" on a phone.
  const [addresses, setAddresses] = useState<Network[]>([]);
  useEvery(() => { getJson<{ addresses: Network[] }>(`${FRONT_DOOR}/ops/network`).then((body) => { if (body) setAddresses(body.addresses); }); }, 10_000);

  return (
    <div className="flex min-h-screen bg-cream text-ink">
      <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r border-line bg-surface/50 px-6 py-7">
        <div className="text-2xl font-bold tracking-[0.35em]">{BRAND.name}</div>
        <div className="mt-4 w-24 text-lg leading-tight">{TAGLINE}</div>
        <nav className="mt-8 space-y-1">
          {NAV.map((item) => (
            <button key={item.id} onClick={() => document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth' })} className="flex w-full items-center gap-3 rounded-row px-3 py-2.5 text-left font-medium hover:bg-ink hover:text-white">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={item.icon} /></svg>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="mt-auto">
          <ChromeBlob size={150} />
          <p className="mt-3 text-small text-muted">{BRAND.tagline}</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 items-start gap-6 px-7 py-5">
        <main className="min-w-0 flex-1">
          <header className="mb-6 flex flex-wrap items-center gap-3">
            <div className="mr-auto">{/* the chips on the right are the "Server address" choices for the phones */}
              <div className="text-tiny uppercase tracking-wide text-muted">{BRAND.name} · Control Room</div>
              <h1 className="text-title font-bold leading-tight">Control Room</h1>
            </div>
            {addresses.map((item) => <CopyChip key={item.address} label={item.name} value={item.address} />)}
            {addresses.length === 0 && <span className="text-small text-muted">No network address found</span>}
            <span className="rounded-pill bg-ok-soft px-4 py-2 text-tiny font-semibold tracking-wide text-ok">DEMO ENVIRONMENT</span>
          </header>

          <Servers />
          <ActivityLog />
          <Setup addresses={addresses} />
        </main>

        <PhoneFrame />
      </div>
    </div>
  );
}

// An address with a Copy button.
function CopyChip({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  return (
    <span className="flex items-center gap-2 rounded-pill border border-line bg-surface py-1 pl-4 pr-1 text-small">
      <span className="text-muted">{label}</span>
      <span className="font-mono font-semibold">{value}</span>
      <button onClick={copy} className="rounded-pill bg-ink px-3 py-1 text-tiny font-semibold text-white">{copied ? 'Copied' : 'Copy'}</button>
    </span>
  );
}

// The phone app itself, in a frame the size of a phone. Same address with ?view=phone, so it shows the
// normal app and keeps its own login like any other phone.
function PhoneFrame() {
  return (
    <div className="sticky top-5 shrink-0">
      <div className="rounded-[44px] bg-ink p-2.5 shadow-2xl">
        <iframe
          title="Laptop phone" src={`${window.location.pathname}?view=phone`} allow="camera"
          className="block w-[390px] rounded-[34px] bg-cream" style={{ height: 'min(844px, calc(100vh - 92px))' }}
        />
      </div>
      <div className="mt-2 text-center text-tiny text-muted">Laptop phone · the same app the phones run</div>
    </div>
  );
}

// ---------- set-up and demo attacks ----------

function Setup({ addresses }: { addresses: Network[] }) {
  const address = addresses[0]?.address; // the Wi-Fi adapter comes first
  return (
    <Section id="setup" title="Setup" note="Connecting the phones">
      <Card className="mb-3">
        <ol className="list-decimal space-y-1.5 pl-5 text-small">
          <li>Put the phones on the same Wi-Fi as this laptop.</li>
          <li>In the TRUE app, type the <b>Server address</b> {address ? <span className="font-mono font-semibold">{address}</span> : 'shown at the top of this page'} (no port) and tap "Save and test connection".</li>
          <li>If it says "not reachable": allow Node.js through Windows Firewall for Private networks.</li>
          <li>Every action on a phone appears in Activity above, labelled Phone 1, Phone 2 in the order they first connect.</li>
        </ol>
      </Card>
      <DemoAttacks address={address} />
    </Section>
  );
}

type Created = { title: string; requestUri: string; walletUrl: string; expiresAt: string };

// Two requests a phone should refuse or warn about. Collapsed until needed.
function DemoAttacks({ address }: { address?: string }) {
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState('');
  // Ask through the laptop's network address when there is one, so the link inside the QR works on a real phone.
  const door = address ? `${address}:4000` : FRONT_DOOR;

  async function create(title: string, body: { verifierId: string; extraClaim?: string }) {
    setError('');
    setCreated(null);
    let claims: string[] | undefined;
    if (body.extraClaim) {
      // Over-ask: what this verifier is registered for, plus one field it has no right to.
      const list = await getJson<{ verifiers: { id: string; claims: string[] }[] }>(`${door}/v1/verifiers`);
      const registered = list?.verifiers.find((v) => v.id === body.verifierId)?.claims;
      if (!registered) { setError('Could not reach the verifier servers.'); return; }
      claims = [...registered, body.extraClaim];
    }
    const made = await getJson<Omit<Created, 'title'>>(`${door}/v1/requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verifierId: body.verifierId, claims }) });
    if (made) setCreated({ ...made, title });
    else setError('Could not create the request. Is a verifier instance alive?');
  }

  return (
    <details className="rounded-card border border-line bg-surface p-4">
      <summary className="cursor-pointer font-semibold">Demo attacks</summary>
      <p className="mt-2 text-small text-muted">Each button makes a real request. Scan the QR with a phone (or paste the link in the Scan tab): the app should warn and refuse.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <SmallButton kind="secondary" onClick={() => create('Fake verifier (Free Prize Booth)', { verifierId: 'verifier:free-prize-booth' })}>Fake verifier (Free Prize Booth)</SmallButton>
        <SmallButton kind="secondary" onClick={() => create('Over-ask request', { verifierId: 'verifier:campus-store', extraClaim: 'address' })}>Over-ask request</SmallButton>
      </div>
      {error && <p className="mt-3 text-small text-bad">{error}</p>}
      {created && (
        <div className="mt-4 flex items-start gap-4">
          <div className="w-72 shrink-0"><QrPanel value={created.walletUrl} caption={`${created.title} · valid until ${new Date(created.expiresAt).toLocaleTimeString('en-GB')}`} /></div>
          <div className="min-w-0 flex-1">
            <div className="mb-1 text-small text-muted">Link (paste in the Scan tab)</div>
            <input readOnly value={created.requestUri} onFocus={(e) => e.target.select()} className="w-full rounded-row border border-line bg-soft px-3 py-2 font-mono text-tiny" />
            {!address && <p className="mt-2 text-small text-warn">No network address was found, so this link contains "localhost" and only works in the laptop phone.</p>}
          </div>
        </div>
      )}
    </details>
  );
}
