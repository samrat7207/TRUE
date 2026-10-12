// Design system: the small set of building blocks every screen is made from.
// Colours, radius and type come from the tokens in index.css.
import { useEffect, useState, type ReactNode } from 'react';
import QRCode from 'qrcode';

// Move to another screen. Screens are chosen by the part of the address after '#'.
export const go = (path: string) => { window.location.hash = '#' + path; };

// ---------- layout ----------

// One phone-sized screen: 390px wide, cream background. `tabs` adds room for the bottom tab bar.
export function Screen({ children, tabs }: { children: ReactNode; tabs?: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[390px] flex-col bg-cream shadow-2xl">
      <main className={`flex-1 px-gutter pt-5 ${tabs ? 'pb-24' : 'pb-8'}`}>{children}</main>
      {tabs}
    </div>
  );
}

// Back arrow, optional title, optional thing on the right.
export function TopBar({ title, back, right }: { title?: string; back?: string; right?: ReactNode }) {
  return (
    <div className="mb-5 flex h-10 items-center justify-between">
      {back !== undefined
        ? <button onClick={() => go(back)} aria-label="Back" className="-ml-2 flex h-10 w-10 items-center justify-center rounded-pill text-xl">←</button>
        : <span className="w-8" />}
      <span className="font-semibold">{title}</span>
      <span className="flex min-w-8 justify-end">{right}</span>
    </div>
  );
}

export type Tab = { path: string; label: string; icon: string };

export const HOLDER_TABS: Tab[] = [
  { path: '/home', label: 'Wallet', icon: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z' },
  { path: '/scan', label: 'Scan', icon: 'M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M8 8h3v3H8zM13 13h3v3h-3z' },
  { path: '/offers', label: 'Offers', icon: 'M4 5h16v11H9l-5 4zM8 9h8M8 12h5' },
  { path: '/registers', label: 'Registers', icon: 'M5 4h14v16H5zM9 8h6M9 12h6M9 16h3' },
];

export const INSTITUTION_TABS: Tab[] = [
  { path: '/inst/home', label: 'Dashboard', icon: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z' },
  { path: '/inst/issue', label: 'Issue ID', icon: 'M12 5v14M5 12h14' },
  { path: '/inst/issued', label: 'Issued', icon: 'M4 6h16M4 12h16M4 18h10' },
  { path: '/inst/activity', label: 'Activity', icon: 'M12 7v5l3 2M21 12a9 9 0 1 1-9-9 9 9 0 0 1 9 9z' },
  { path: '/inst/account', label: 'Account', icon: 'M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zM4 21a8 8 0 0 1 16 0' },
];

// Fixed bar at the bottom with the main places.
export function BottomTabs({ active, tabs = HOLDER_TABS }: { active: string; tabs?: Tab[] }) {
  return (
    <nav className="fixed bottom-0 left-1/2 flex w-full max-w-[390px] -translate-x-1/2 justify-around border-t border-line bg-surface/95 px-2 pb-3 pt-2 backdrop-blur">
      {tabs.map((tab) => (
        <button key={tab.path} onClick={() => go(tab.path)} className={`flex w-14 flex-col items-center gap-1 text-tiny ${active === tab.path ? 'font-semibold text-ink' : 'text-muted'}`}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active === tab.path ? 2.2 : 1.6} strokeLinecap="round" strokeLinejoin="round"><path d={tab.icon} /></svg>
          {tab.label}
        </button>
      ))}
    </nav>
  );
}

// ---------- surfaces ----------

// White rounded box. Pass onClick to make the whole card a button.
export function Card({ children, onClick, tone = 'plain', className = '' }: {
  children: ReactNode; onClick?: () => void; tone?: 'plain' | 'ok' | 'warn' | 'bad' | 'dark'; className?: string;
}) {
  const tones = {
    plain: 'bg-surface border-line',
    ok: 'bg-ok-soft border-ok/30',
    warn: 'bg-warn-soft border-warn/40',
    bad: 'bg-bad-soft border-bad/40',
    dark: 'bg-ink border-ink text-white',
  };
  const classes = `block w-full rounded-card border p-4 text-left ${tones[tone]} ${className}`;
  return onClick ? <button onClick={onClick} className={classes}>{children}</button> : <div className={classes}>{children}</div>;
}

// The main button shape. primary = black pill, secondary = white pill, danger = red outline.
export function PillButton({ children, onClick, kind = 'primary', disabled }: {
  children: ReactNode; onClick?: () => void; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean;
}) {
  const kinds = {
    primary: 'bg-ink text-white',
    secondary: 'bg-surface text-ink border border-line',
    danger: 'bg-bad-soft text-bad border border-bad/40',
  };
  return (
    <button onClick={onClick} disabled={disabled} className={`h-13 w-full rounded-pill px-5 py-3.5 font-semibold transition disabled:opacity-35 ${kinds[kind]}`}>
      {children}
    </button>
  );
}

// A row of filter chips; the chosen one is black.
export function Chips<T extends string>({ options, value, onChange }: { options: Record<T, string>; value: T; onChange: (value: T) => void }) {
  return (
    <div className="mb-4 flex gap-2 overflow-x-auto">
      {(Object.keys(options) as T[]).map((key) => (
        <button key={key} onClick={() => onChange(key)} className={`shrink-0 rounded-pill px-4 py-1.5 text-small font-medium ${value === key ? 'bg-ink text-white' : 'border border-line bg-surface text-muted'}`}>
          {options[key]}
        </button>
      ))}
    </div>
  );
}

// Small coloured label, e.g. "Verified".
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'ok' | 'warn' | 'bad' | 'neutral' }) {
  const tones = { ok: 'bg-ok-soft text-ok', warn: 'bg-warn-soft text-warn', bad: 'bg-bad-soft text-bad', neutral: 'bg-soft text-muted border border-line' };
  return <span className={`inline-block rounded-pill px-2.5 py-0.5 text-tiny font-semibold ${tones[tone]}`}>{children}</span>;
}

// Initial letters on a solid colour. We never show photos.
const AVATAR_COLOURS = ['#0b0b0c', '#2f6bff', '#15803d', '#b45309', '#7c3aed', '#be185d', '#0e7490'];
export function Avatar({ name, size = 44 }: { name: string; size?: number }) {
  const initials = name.split(/[\s:-]+/).filter(Boolean).slice(0, 2).map((word) => word[0].toUpperCase()).join('') || '?';
  // Same name => same colour, picked by adding up the letters.
  const colour = AVATAR_COLOURS[[...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % AVATAR_COLOURS.length];
  return (
    <span className="flex shrink-0 items-center justify-center rounded-pill font-semibold text-white" style={{ width: size, height: size, background: colour, fontSize: size * 0.36 }}>
      {initials}
    </span>
  );
}

// ---------- rows ----------

// One line on the consent screen: a tick box, a name and a short description.
// "locked" rows cannot be changed (the verifier needs them, or they are not asked for).
export function ConsentRow({ label, description, checked, locked, tone = 'plain', onChange }: {
  label: string; description: string; checked: boolean; locked?: boolean; tone?: 'plain' | 'warn'; onChange?: (checked: boolean) => void;
}) {
  return (
    <label className={`flex items-center gap-3 rounded-row border px-3.5 py-3 ${tone === 'warn' ? 'border-warn/40 bg-warn-soft' : 'border-line bg-surface'} ${locked ? '' : 'cursor-pointer'}`}>
      <input type="checkbox" checked={checked} disabled={locked} onChange={(e) => onChange?.(e.target.checked)} className="sr-only" />
      <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 text-sm font-bold ${checked ? 'border-ink bg-ink text-white' : 'border-line bg-surface text-transparent'}`}>✓</span>
      <span className="min-w-0">
        <span className={`block font-medium ${checked ? '' : 'text-muted'}`}>{label}</span>
        <span className="block text-small text-muted">{description}</span>
      </span>
    </label>
  );
}

export type StepItem = { label: string; status: 'pass' | 'fail' | 'skipped' | 'running' | 'waiting' };

// The check list on the Verifying and Result screens.
export function StepList({ steps }: { steps: StepItem[] }) {
  const mark = {
    pass: { text: '✓', classes: 'bg-ink text-white' },
    fail: { text: '✕', classes: 'bg-bad text-white' },
    skipped: { text: '–', classes: 'bg-soft text-muted border border-line' },
    running: { text: '', classes: 'border-2 border-accent border-t-transparent animate-spin' },
    waiting: { text: '', classes: 'border-2 border-line' },
  };
  return (
    <ul className="space-y-3.5">
      {steps.map((step) => (
        <li key={step.label} className="flex items-center gap-3">
          <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-pill text-xs font-bold ${mark[step.status].classes}`}>{mark[step.status].text}</span>
          <span className={step.status === 'waiting' || step.status === 'skipped' ? 'text-muted' : ''}>
            {step.label}
            {step.status === 'fail' && <span className="ml-2 text-small font-semibold text-bad">failed</span>}
            {step.status === 'skipped' && <span className="ml-2 text-small">not checked</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

// A QR code in a white card, with a caption. The QR is drawn in the browser from the given text.
export function QrPanel({ value, caption }: { value: string; caption?: string }) {
  const [image, setImage] = useState('');
  useEffect(() => { QRCode.toDataURL(value, { width: 240, margin: 1 }).then(setImage); }, [value]);
  return (
    <Card className="text-center">
      {image && <img src={image} alt="QR code" className="mx-auto" width={240} height={240} />}
      {caption && <div className="mt-2 text-small text-muted">{caption}</div>}
    </Card>
  );
}

// Two-column "label … value" line used in detail lists.
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line py-2.5 last:border-0">
      <span className="text-small text-muted">{label}</span>
      <span className="text-right text-small font-medium break-all">{children}</span>
    </div>
  );
}

// ---------- splash blob ----------

// The chrome blob from the splash design, drawn with SVG gradients and a blurred glow. No image file.
export function Blob({ size = 230 }: { size?: number }) {
  return (
    <div className="relative mx-auto" style={{ width: size, height: size }}>
      <div className="absolute inset-6 rounded-full blur-2xl" style={{ background: 'radial-gradient(circle at 35% 70%, #7aa5ff 0%, #b9a8ff 45%, transparent 70%)' }} />
      <svg viewBox="0 0 200 200" className="drift absolute inset-0" aria-hidden="true">
        <defs>
          <linearGradient id="chrome" x1="0.1" y1="0" x2="0.9" y2="1">
            <stop offset="0" stopColor="#fdfdfd" />
            <stop offset="0.28" stopColor="#8f9196" />
            <stop offset="0.5" stopColor="#f2f3f5" />
            <stop offset="0.72" stopColor="#55585e" />
            <stop offset="1" stopColor="#e6e8ec" />
          </linearGradient>
          <radialGradient id="shine" cx="0.32" cy="0.26" r="0.5">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.95" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
        </defs>
        <path fill="url(#chrome)" d="M118 22c22-9 46 6 48 30 2 20-14 30-18 48-5 22 26 40 14 62-10 18-36 20-52 8-14-10-18-30-36-36-18-6-44 2-52-18-8-20 12-38 32-40 22-2 36 10 50-2 12-10 0-44 14-52z" />
        <path fill="url(#shine)" d="M118 22c22-9 46 6 48 30 2 20-14 30-18 48-5 22 26 40 14 62-10 18-36 20-52 8-14-10-18-30-36-36-18-6-44 2-52-18-8-20 12-38 32-40 22-2 36 10 50-2 12-10 0-44 14-52z" />
      </svg>
    </div>
  );
}

// Round glowing badge with a tick or a cross (Verifying / Result screens).
export function Orb({ state }: { state: 'working' | 'ok' | 'bad' }) {
  const colours = {
    working: 'radial-gradient(circle at 35% 30%, #ffffff 0%, #cfe0ff 45%, #c9b8ff 100%)',
    ok: 'radial-gradient(circle at 35% 30%, #ffffff 0%, #c9f2d6 45%, #9be0b4 100%)',
    bad: 'radial-gradient(circle at 35% 30%, #ffffff 0%, #ffd5d5 45%, #f5a3a3 100%)',
  };
  const symbol = { working: '', ok: '✓', bad: '✕' };
  return (
    <div className={`mx-auto flex h-28 w-28 items-center justify-center rounded-full text-5xl font-bold shadow-lg ${state === 'working' ? 'pulse-ring' : ''} ${state === 'ok' ? 'text-ok' : 'text-bad'}`} style={{ background: colours[state] }}>
      {symbol[state]}
    </div>
  );
}
