// Client for the TrustRegistry contract on the local chain. Uses viem. Works in Node and in the browser.
// Readers need no account. Writers send transactions from an account the local chain node has unlocked.
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { hardhat } from 'viem/chains';

// The contract's functions, written out so this file can be read without the compiled artifact.
export const REGISTRY_ABI = parseAbi([
  'function issuerCount() view returns (uint256)',
  'function issuerIds(uint256 index) view returns (string)',
  'function issuerAdmin(string issuerId) view returns (address)',
  'function issuerName(string issuerId) view returns (string)',
  'function issuerVerified(string issuerId) view returns (bool)',
  'function issuerKeys(string issuerId, string keyId) view returns (string publicJwk, uint8 state)',
  'function verifiers(string verifierId) view returns (string name, string allowedClaims, string publicJwk, bool registered, string pinnedTo)',
  'function statusAnchors(string issuerId) view returns (bytes32 listHash, uint256 version)',
  'function registerIssuer(string issuerId, string name, address admin)',
  'function setIssuerVerified(string issuerId, bool verified)',
  'function registerVerifier(string verifierId, string name, string allowedClaims, string publicJwk, string pinnedTo)',
  'function removeVerifier(string verifierId)',
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
export type IssuerInfo = { id: string; name: string; verified: boolean };
// pinnedIssuer / pinnedType are '' when the verifier accepts any issuer / type.
export type VerifierInfo = { name: string; allowedClaims: string[]; publicJwk: Record<string, unknown>; pinnedIssuer: string; pinnedType: string };

// Read-only access. Anyone can do this: the registry is public.
export function createRegistryReader(config: { rpcUrl: string; address: `0x${string}` }) {
  const client = createPublicClient({ chain: hardhat, transport: http(config.rpcUrl) });
  const read = { address: config.address, abi: REGISTRY_ABI } as const;

  // An institution's public name and whether the operator has verified it. Null if it is not in the registry.
  async function getIssuer(issuerId: string): Promise<IssuerInfo | null> {
    const name = await client.readContract({ ...read, functionName: 'issuerName', args: [issuerId] });
    if (!name) return null;
    return { id: issuerId, name, verified: await client.readContract({ ...read, functionName: 'issuerVerified', args: [issuerId] }) };
  }

  return {
    getIssuer,
    // Every institution in the registry (for the "choose an institution" list).
    async listIssuers(): Promise<IssuerInfo[]> {
      const count = Number(await client.readContract({ ...read, functionName: 'issuerCount' }));
      const ids = await Promise.all(Array.from({ length: count }, (_, i) => client.readContract({ ...read, functionName: 'issuerIds', args: [BigInt(i)] })));
      // Entries that are not institutions (the issuing service's revocation-list id) are left out.
      const issuers = await Promise.all(ids.filter((id) => id.startsWith('inst:')).map(getIssuer));
      return issuers.filter((issuer): issuer is IssuerInfo => issuer !== null);
    },
    // An issuer's signing key and its state, or null if that key id was never published.
    async getIssuerKey(issuerId: string, keyId: string): Promise<IssuerKeyInfo | null> {
      const [publicJwk, state] = await client.readContract({ ...read, functionName: 'issuerKeys', args: [issuerId, keyId] });
      if (state === 0) return null;
      return { publicJwk: JSON.parse(publicJwk), state: KEY_STATES[state] };
    },
    // A registered verifier (register), or null if nobody registered that id or it was removed.
    async getVerifier(verifierId: string): Promise<VerifierInfo | null> {
      const [name, allowedClaims, publicJwk, registered, pinnedTo] = await client.readContract({ ...read, functionName: 'verifiers', args: [verifierId] });
      if (!registered) return null;
      // On the chain the pin is one text: "<issuer id>|<credential type>" (empty when not pinned).
      const [pinnedIssuer = '', pinnedType = ''] = pinnedTo.split('|');
      return { name, allowedClaims: allowedClaims.split(',').filter(Boolean), publicJwk: JSON.parse(publicJwk), pinnedIssuer, pinnedType };
    },
    // Fingerprint and version of a revocation list. Hash is hex without "0x".
    async getStatusAnchor(listId: string): Promise<{ hash: string; version: number }> {
      const [listHash, version] = await client.readContract({ ...read, functionName: 'statusAnchors', args: [listId] });
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
    setIssuerVerified: async (issuerId: string, verified: boolean) =>
      mined(await wallet.writeContract({ ...base, functionName: 'setIssuerVerified', args: [issuerId, verified] })),
    registerVerifier: async (verifierId: string, name: string, allowedClaims: string[], publicJwk: object, pinnedIssuer = '', pinnedType = '') =>
      mined(await wallet.writeContract({ ...base, functionName: 'registerVerifier', args: [verifierId, name, allowedClaims.join(','), JSON.stringify(publicJwk), pinnedIssuer ? `${pinnedIssuer}|${pinnedType}` : ''] })),
    removeVerifier: async (verifierId: string) =>
      mined(await wallet.writeContract({ ...base, functionName: 'removeVerifier', args: [verifierId] })),
    addIssuerKey: async (issuerId: string, keyId: string, publicJwk: object) =>
      mined(await wallet.writeContract({ ...base, functionName: 'addIssuerKey', args: [issuerId, keyId, JSON.stringify(publicJwk)] })),
    setIssuerKeyState: async (issuerId: string, keyId: string, state: 'Retired' | 'Compromised') =>
      mined(await wallet.writeContract({ ...base, functionName: 'setIssuerKeyState', args: [issuerId, keyId, KEY_STATES.indexOf(state)] })),
    anchorStatusList: async (listId: string, hashHex: string, version: number) =>
      mined(await wallet.writeContract({ ...base, functionName: 'anchorStatusList', args: [listId, `0x${hashHex}`, BigInt(version)] })),
  };
}
