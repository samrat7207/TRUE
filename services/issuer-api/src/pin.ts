// Staff PIN hashing. Server-only, so it uses Node's built-in crypto (scrypt), not our browser-safe
// packages/credentials. We implement nothing ourselves: scrypt is a standard slow password hash,
// each staff member gets their own random salt, and the comparison is constant-time.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// Returns "salt:hash" (both hex). Only this string is stored; the PIN itself never is.
export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(pin, salt, 32).toString('hex')}`;
}

export function pinMatches(pin: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(pin, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}
