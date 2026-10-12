// Password hashing. Server-only, so it uses Node's built-in crypto (scrypt), not our browser-safe
// packages/credentials. We implement nothing ourselves: scrypt is a standard slow password hash,
// each account gets its own random salt, and the comparison is constant-time.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// Returns "salt:hash" (both hex). Only this string is stored; the password itself never is.
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(password, salt, 32).toString('hex')}`;
}

export function passwordMatches(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}
