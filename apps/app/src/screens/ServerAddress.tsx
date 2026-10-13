// "Server address": the one setting that tells the app where the laptop's servers are.
// Shown on the first screen (before login) and in Profile.
import { useState } from 'react';
import { Card, PillButton } from '../ui.tsx';
import { getServerAddress, isNativeApp, normalizeAddress, setServerAddress, testConnection } from '../server.ts';

export function ServerAddress() {
  const [value, setValue] = useState(getServerAddress());
  const [saved, setSaved] = useState(getServerAddress());
  const [result, setResult] = useState<{ core: boolean; verifier: boolean } | 'testing' | null>(null);

  // Saves what was typed, then tries both servers at that address.
  async function saveAndTest() {
    const address = setServerAddress(value);
    setValue(address);
    setSaved(address);
    setResult('testing');
    setResult(await testConnection(address));
  }

  const changed = normalizeAddress(value) !== saved;
  return (
    <Card className="text-left">
      <label className="block text-small font-semibold">Server address
        <input
          value={value} onChange={(e) => { setValue(e.target.value); setResult(null); }} placeholder="http://192.168.1.20"
          inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false}
          className="mt-1 w-full rounded-row border border-line bg-surface px-3 py-3 font-mono text-small font-normal"
        />
      </label>
      <p className="mt-1 text-tiny text-muted">
        {isNativeApp ? "The laptop's IP address on this Wi-Fi, without a port." : 'Where the servers run. Leave as it is when using the laptop itself.'}
        {' '}The app uses port 4001 (accounts) and port 4000 (verifier) at this address.
      </p>
      <div className="mt-3"><PillButton kind="secondary" onClick={saveAndTest} disabled={!value.trim()}>{changed ? 'Save and test connection' : 'Test connection'}</PillButton></div>
      {result === 'testing' && <p className="mt-2 text-small text-muted">Testing…</p>}
      {result && result !== 'testing' && (
        <p className={`mt-2 text-small font-semibold ${result.core && result.verifier ? 'text-ok' : 'text-bad'}`}>
          Accounts server (4001): {result.core ? 'reachable' : 'not reachable'} · Verifier (4000): {result.verifier ? 'reachable' : 'not reachable'}
        </p>
      )}
      {!saved && <p className="mt-2 text-small text-warn">No server address yet: the app cannot log in until one is saved.</p>}
    </Card>
  );
}
