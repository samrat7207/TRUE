// Revocation bit list helpers. One bit per credential: 1 = revoked.
// The list is stored as a hex string (two characters per byte). Plain arithmetic, no cryptography.

// Bitwise OR of two lists. A bit that is 1 on either side stays 1, so "revoked" can never be undone by merging.
export function orHex(a: string, b: string): string {
  const length = Math.max(a.length, b.length);
  let out = '';
  for (let i = 0; i < length; i += 2) {
    const byte = parseInt(a.slice(i, i + 2) || '0', 16) | parseInt(b.slice(i, i + 2) || '0', 16);
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

// Returns the list with the bit at `index` set to 1.
export function setBit(hex: string, index: number): string {
  const byte = Math.floor(index / 8);
  const mask = '00'.repeat(byte) + (1 << (index % 8)).toString(16).padStart(2, '0');
  return orHex(hex, mask);
}

export function isBitSet(hex: string, index: number): boolean {
  const start = Math.floor(index / 8) * 2;
  const byte = parseInt(hex.slice(start, start + 2) || '0', 16);
  return (byte & (1 << (index % 8))) !== 0;
}
