// First screen: the splash blob and the role choice. No email, password or third-party login.
import { BRAND } from '@true/shared';
import { Blob, Card, PillButton, Screen, TopBar, go } from '../ui.tsx';

export function RolePicker() {
  return (
    <Screen>
      <div className="flex items-center justify-between pt-2">
        <span className="text-lg font-bold tracking-[0.35em]">{BRAND.name.split('').join(' ')}</span>
      </div>

      <div className="py-6"><Blob /></div>

      <p className="text-xl">Welcome to</p>
      <h1 className="text-4xl font-bold tracking-tight">{BRAND.name}</h1>
      <p className="mt-1 text-small text-muted">{BRAND.fullForm}</p>
      <p className="mt-3 text-muted">{BRAND.tagline}</p>
      <p className="mt-5 mb-3 text-small text-muted">Choose how you want to continue.</p>

      <div className="space-y-3">
        <Card onClick={() => go('/home')}>
          <div className="flex items-center gap-3">
            <RoleIcon path="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zM4 21a8 8 0 0 1 16 0" />
            <div>
              <div className="font-semibold">I'm a User</div>
              <div className="text-small text-muted">Hold my credentials and share proofs</div>
            </div>
          </div>
        </Card>
        <Card onClick={() => go('/issuer')} tone="dark">
          <div className="flex items-center gap-3">
            <RoleIcon dark path="M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18" />
            <div>
              <div className="font-semibold">I'm an Issuer</div>
              <div className="text-small text-white/70">Issue and manage credentials</div>
            </div>
          </div>
        </Card>
      </div>
    </Screen>
  );
}

function RoleIcon({ path, dark }: { path: string; dark?: boolean }) {
  return (
    <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-row ${dark ? 'bg-white/10' : 'bg-soft border border-line'}`}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={path} /></svg>
    </span>
  );
}

// Issuer mode arrives in the next phase. Until then the existing issuer console keeps working.
export function IssuerPlaceholder() {
  return (
    <Screen>
      <TopBar back="/" title="Issuer" />
      <Card>
        <div className="text-lg font-semibold">Issuer mode: next phase</div>
        <p className="mt-2 text-small text-muted">
          This screen is a placeholder. Issuing, revoking and key management still work today in the existing issuer console.
        </p>
      </Card>
      <div className="mt-4"><PillButton kind="secondary" onClick={() => go('/')}>Back</PillButton></div>
    </Screen>
  );
}
