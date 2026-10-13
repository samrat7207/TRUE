// Where the servers are. ONE address (for example http://192.168.1.20), stored on this device.
// Everything else is derived from it: the core API on port 4001 and the verifier front door on port 4000.
//   - In a browser the default is the machine this page was loaded from, so dev on the laptop works as before.
//   - In the Android app there is no default: the address must be typed in once (it is never "localhost",
//     because on a phone "localhost" is the phone itself).
import { Capacitor } from '@capacitor/core';

const KEY = 'true-server-address';
export const isNativeApp = Capacitor.isNativePlatform();

// "192.168.1.20", "http://192.168.1.20/" and "192.168.1.20:4001" all become "http://192.168.1.20".
export function normalizeAddress(input: string): string {
  const value = input.trim();
  if (!value) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`);
    return `${url.protocol}//${url.hostname}`;
  } catch {
    return '';
  }
}

export function getServerAddress(): string {
  const saved = localStorage.getItem(KEY);
  if (saved !== null) return saved;
  return isNativeApp ? '' : `http://${window.location.hostname}`;
}

export function setServerAddress(input: string): string {
  const address = normalizeAddress(input);
  localStorage.setItem(KEY, address);
  return address;
}

export const coreApi = () => `${getServerAddress()}:4001`;
export const verifierApi = () => `${getServerAddress()}:4000`;

// "Test connection": can this device reach both servers at that address right now?
export async function testConnection(address = getServerAddress()): Promise<{ core: boolean; verifier: boolean }> {
  const reachable = (url: string) => fetch(url, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false);
  if (!address) return { core: false, verifier: false };
  const [core, verifier] = await Promise.all([reachable(`${address}:4001/v1/status-list`), reachable(`${address}:4000/health`)]);
  return { core, verifier };
}
