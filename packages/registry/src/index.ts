// Client for the TrustRegistry contract on the local chain. Uses viem. Works in Node and in the browser.
// Readers need no account. Writers send transactions from an account the local chain node has unlocked.
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { hardhat } from 'viem/chains';

// The contract's functions, written out so this file can be read without the compiled artifact.
export const REGISTRY_ABI = parseAbi([
  'function issuerAdmin(string issuerId) view returns (address)',
  'function issuerKeys(string issuerId, string keyId) view returns (string publicJwk, uint8 state)',
  'function verifiers(string verifierId) view returns (string name, string allowedClaims, string publicJwk, bool registered)',
  'function statusAnchors(string issuerId) view returns (bytes32 listHash, uint256 version)',
  'function registerIssuer(string issuerId, string name, address admin)',
  'function registerVerifier(string verifierId, string name, string allowedClaims, string publicJwk)',
  'function addIssuerKey(string issuerId, string keyId, string publicJwk)',
  'function setIssuerKeyState(string issuerId, string keyId, uint8 state)',
  'function anchorStatusList(string issuerId, bytes32 listHash, uint256 version)',
]);

// Where the registry lives. Written to data/chain.json by scripts/chain-setup.ts.
export type ChainConfig = { rpcUrl: string; address: `0x${string}`; owner: `0x${string}`; issuerAdmin: `0x${string}` };

// Same order as the enum in the contract.
export const KEY_STATES = ['None', 'Active', 'Retired', 'Compromised'] as const;
export type KeyState = (typeof KEY_STATES)[number];

export type IssuerKeyInfo = { publicJwk: Record<string, unknown>; state: KeyState };
export type VerifierInfo = { name: string; allowedClaims: string[]; publicJwk: Record<string, unknown> };

// Read-only access. Anyone can do this: the registry is public.
export function createRegistryReader(config: { rpcUrl: string; address: `0x${string}` }) {
  const client = createPublicClient({ chain: hardhat, transport: http(config.rpcUrl) });
  const read = { address: config.address, abi: REGISTRY_ABI } as const;
  return {
    // An issuer's signing key and its state, or null if that key id was never published.
    async getIssuerKey(issuerId: string, keyId: string): Promise<IssuerKeyInfo | null> {
      const [publicJwk, state] = await client.readContract({ ...read, functionName: 'issuerKeys', args: [issuerId, keyId] });
      if (state === 0) return null;
      return { publicJwk: JSON.parse(publicJwk), state: KEY_STATES[state] };
    },
    // A registered verifier, or null if nobody registered that id.
    async getVerifier(verifierId: string): Promise<VerifierInfo | null> {
      const [name, allowedClaims, publicJwk, registered] = await client.readContract({ ...read, functionName: 'verifiers', args: [verifierId] });
      if (!registered) return null;
      return { name, allowedClaims: allowedClaims.split(',').filter(Boolean), publicJwk: JSON.parse(publicJwk) };
    },
    // Fingerprint and version of the issuer's current revocation list. Hash is hex without "0x".
    async getStatusAnchor(issuerId: string): Promise<{ hash: string; version: number }> {
      const [listHash, version] = await client.readContract({ ...read, functionName: 'statusAnchors', args: [issuerId] });
      return { hash: listHash.slice(2), version: Number(version) };
    },
    async getIssuerAdmin(issuerId: string): Promise<string> {
      return client.readContract({ ...read, functionName: 'issuerAdmin', args: [issuerId] });
    },
  };
}

// Write access from one account. Each call waits until the transaction is mined.
export function createRegistryWriter(config: { rpcUrl: string; address: `0x${string}` }, account: `0x${string}`) {
  const publicClient = createPublicClient({ chain: hardhat, transport: http(config.rpcUrl) });
  const wallet = createWalletClient({ chain: hardhat, transport: http(config.rpcUrl), account });
  const base = { address: config.address, abi: REGISTRY_ABI } as const;
  const mined = (hash: `0x${string}`) => publicClient.waitForTransactionReceipt({ hash });
  return {
    registerIssuer: async (issuerId: string, name: string, admin: `0x${string}`) =>
      mined(await wallet.writeContract({ ...base, functionName: 'registerIssuer', args: [issuerId, name, admin] })),
    registerVerifier: async (verifierId: string, name: string, allowedClaims: string[], publicJwk: object) =>
      mined(await wallet.writeContract({ ...base, functionName: 'registerVerifier', args: [verifierId, name, allowedClaims.join(','), JSON.stringify(publicJwk)] })),
    addIssuerKey: async (issuerId: string, keyId: string, publicJwk: object) =>
      mined(await wallet.writeContract({ ...base, functionName: 'addIssuerKey', args: [issuerId, keyId, JSON.stringify(publicJwk)] })),
    setIssuerKeyState: async (issuerId: string, keyId: string, state: 'Retired' | 'Compromised') =>
      mined(await wallet.writeContract({ ...base, functionName: 'setIssuerKeyState', args: [issuerId, keyId, KEY_STATES.indexOf(state)] })),
    anchorStatusList: async (issuerId: string, hashHex: string, version: number) =>
      mined(await wallet.writeContract({ ...base, functionName: 'anchorStatusList', args: [issuerId, `0x${hashHex}`, BigInt(version)] })),
  };
}
