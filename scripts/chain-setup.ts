// Deploys and seeds the TrustRegistry on the local chain. Safe to run again: it only does what is missing.
// Run by "npm run dev" after the chain node has started.
//   1. wait for the chain node
//   2. deploy TrustRegistry (skipped if data/chain.json points at a live contract)
//   3. register the issuing service's revocation-list id and the demo verifiers (skipped if already there)
//      (institutions register themselves when the core API starts or when one signs up)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http } from 'viem';
import { hardhat } from 'viem/chains';
import { CHAIN_RPC_URL, STATUS_LIST_ID } from '@true/shared';
import { generateSigningKeyPair, type Jwk } from '@true/credentials';
import { REGISTRY_ABI, createRegistryReader, createRegistryWriter, type ChainConfig } from '@true/registry';
import { DEMO_VERIFIERS } from '../services/verifier-api/src/db.ts';

const CHAIN_FILE = new URL('../data/chain.json', import.meta.url);
const ARTIFACT = new URL('../contracts/artifacts/contracts/TrustRegistry.sol/TrustRegistry.json', import.meta.url);
const VERIFIER_KEYS_FILE = new URL('../services/verifier-api/data/verifier-keys.json', import.meta.url);

const client = createPublicClient({ chain: hardhat, transport: http(CHAIN_RPC_URL) });

// 1. Wait up to 60 seconds for the node to answer.
for (let attempt = 0; ; attempt++) {
  try { await client.getChainId(); break; } catch {
    if (attempt >= 60) throw new Error(`No chain node at ${CHAIN_RPC_URL}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// The node comes with unlocked test accounts. Account 0 is the registry owner, account 1 is the issuer's admin.
const wallet = createWalletClient({ chain: hardhat, transport: http(CHAIN_RPC_URL) });
const [owner, issuerAdmin] = await wallet.getAddresses();

// 2. Deploy, unless the saved address still has a contract (same chain run).
let config: ChainConfig | null = existsSync(CHAIN_FILE) ? JSON.parse(readFileSync(CHAIN_FILE, 'utf8')) : null;
// "Deployed" means: there is code at the saved address AND it is this version of the contract
// (an older version does not have issuerCount, so the call fails and we deploy again).
const alreadyDeployed = config
  ? await client.readContract({ address: config.address, abi: REGISTRY_ABI, functionName: 'issuerCount' }).then(() => true, () => false)
  : false;
if (!config || !alreadyDeployed) {
  const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, account: owner });
  const receipt = await client.waitForTransactionReceipt({ hash });
  config = { rpcUrl: CHAIN_RPC_URL, address: receipt.contractAddress!, owner, issuerAdmin };
  mkdirSync(new URL('./', CHAIN_FILE), { recursive: true });
  writeFileSync(CHAIN_FILE, JSON.stringify(config, null, 2));
  console.log('TrustRegistry deployed at', config.address);
} else {
  console.log('TrustRegistry already deployed at', config.address);
}

const reader = createRegistryReader(config);
const asOwner = createRegistryWriter(config, owner);

// 3a. The issuing service's account (account 1) is the only one allowed to anchor the revocation list fingerprint.
if ((await reader.getIssuerAdmin(STATUS_LIST_ID)).toLowerCase() !== issuerAdmin.toLowerCase()) {
  await asOwner.registerIssuer(STATUS_LIST_ID, 'TRUE issuance service (revocation list)', issuerAdmin);
  console.log('Registered revocation list id', STATUS_LIST_ID);
}

// 3b. The verifiers: each has its own signing key. Private keys stay in the verifier's git-ignored data folder.
// Verifiers marked registered:false (the fake one) get a key but are deliberately NOT put on the chain.
mkdirSync(new URL('./', VERIFIER_KEYS_FILE), { recursive: true });
const keys: Record<string, { publicJwk: Jwk; privateJwk: Jwk }> = existsSync(VERIFIER_KEYS_FILE)
  ? JSON.parse(readFileSync(VERIFIER_KEYS_FILE, 'utf8'))
  : {};
for (const verifier of DEMO_VERIFIERS) {
  keys[verifier.id] ??= await generateSigningKeyPair();
  if (!verifier.registered) continue;
  const onChain = await reader.getVerifier(verifier.id);
  if (!onChain || JSON.stringify(onChain.publicJwk) !== JSON.stringify(keys[verifier.id].publicJwk)) {
    await asOwner.registerVerifier(verifier.id, verifier.name, verifier.claims, keys[verifier.id].publicJwk);
    console.log('Registered verifier', verifier.id);
  }
}
writeFileSync(VERIFIER_KEYS_FILE, JSON.stringify(keys, null, 2));
console.log('Chain setup complete');
