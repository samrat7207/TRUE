// Welcome, sign up and log in. Everyone uses an email and a password; the account is a PERSON or an INSTITUTION.
import { useState } from 'react';
import { BRAND, INSTITUTION_CATEGORIES } from '@true/shared';
import { Blob, Card, PillButton, Screen, TopBar, go } from '../ui.tsx';
import { api, setSession, type Session } from '../session.ts';

const INPUT = 'mt-1 w-full rounded-row border border-line bg-surface px-4 py-3 font-normal';
const DemoNote = () => <p className="mt-4 text-center text-tiny text-muted">Demo: emails are not verified. Use made-up addresses.</p>;

export function Welcome() {
  return (
    <Screen>
      <div className="pt-2 text-lg font-bold tracking-[0.35em]">{BRAND.name.split('').join(' ')}</div>
      <div className="py-6"><Blob /></div>
      <p className="text-xl">Welcome to</p>
      <h1 className="text-4xl font-bold tracking-tight">{BRAND.name}</h1>
      <p className="mt-1 text-small text-muted">{BRAND.fullForm}</p>
      <p className="mt-3 mb-8 text-muted">{BRAND.tagline}</p>
      <div className="space-y-3">
        <PillButton onClick={() => go('/signup')}>Create an account</PillButton>
        <PillButton kind="secondary" onClick={() => go('/login')}>Log in</PillButton>
      </div>
      <DemoNote />
    </Screen>
  );
}

export function SignUp() {
  const [kind, setKind] = useState<'person' | 'institution'>('person');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [category, setCategory] = useState('college');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const session = await api<Session>('/v1/auth/signup', { kind, name, email, password, ...(kind === 'institution' ? { category } : {}) });
      setSession(session);
      go('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign up');
    }
    setBusy(false);
  }

  return (
    <Screen>
      <TopBar back="/" />
      <h1 className="text-title font-bold leading-tight">Create an account</h1>
      <p className="mt-2 mb-4 text-muted">Choose the kind of account. It cannot be changed later.</p>

      <div className="mb-5 grid grid-cols-2 gap-2">
        {([['person', 'Person', 'Hold IDs, share proofs'], ['institution', 'Institution', 'Issue IDs to people']] as const).map(([value, title, hint]) => (
          <Card key={value} onClick={() => setKind(value)} tone={kind === value ? 'dark' : 'plain'}>
            <div className="font-semibold">{title}</div>
            <div className={`text-small ${kind === value ? 'text-white/70' : 'text-muted'}`}>{hint}</div>
          </Card>
        ))}
      </div>

      <label className="block text-small font-semibold">{kind === 'person' ? 'Your full name' : 'Institution name'}
        <input value={name} onChange={(e) => setName(e.target.value)} className={INPUT} />
      </label>
      {kind === 'institution' && (
        <label className="mt-3 block text-small font-semibold">Kind of institution
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={INPUT}>
            {Object.entries(INSTITUTION_CATEGORIES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      )}
      <label className="mt-3 block text-small font-semibold">Email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" className={INPUT} />
      </label>
      <label className="mt-3 block text-small font-semibold">Password (at least 8 characters)
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" className={INPUT} />
      </label>

      {kind === 'institution' && (
        <Card tone="warn" className="mt-4"><p className="text-small">A new institution shows as <b>Unverified</b> to people until the operator of this demo verifies it.</p></Card>
      )}
      {error && <Card tone="bad" className="mt-4"><span className="text-small text-bad">{error}</span></Card>}
      <div className="mt-5"><PillButton onClick={submit} disabled={busy || name.trim().length < 2 || !email.includes('@') || password.length < 8}>{busy ? 'Creating…' : 'Create account'}</PillButton></div>
      <DemoNote />
    </Screen>
  );
}

export function LogIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      setSession(await api<Session>('/v1/auth/login', { email, password }));
      go('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not log in');
    }
    setBusy(false);
  }

  return (
    <Screen>
      <TopBar back="/" />
      <h1 className="text-title font-bold leading-tight">Log in</h1>
      <p className="mt-2 mb-5 text-muted">People and institutions log in the same way.</p>
      <label className="block text-small font-semibold">Email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" className={INPUT} />
      </label>
      <label className="mt-3 block text-small font-semibold">Password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} autoComplete="current-password" className={INPUT} />
      </label>
      {error && <Card tone="bad" className="mt-4"><span className="text-small text-bad">{error}</span></Card>}
      <div className="mt-5"><PillButton onClick={submit} disabled={busy || !email || !password}>{busy ? 'Checking…' : 'Log in'}</PillButton></div>
      <p className="mt-4 text-center text-small text-muted">Demo accounts and their passwords are listed in the README and the project's .env file.</p>
      <DemoNote />
    </Screen>
  );
}
