<<<<<<< HEAD
<!-- brand:start -->
# TRUE

**Trusted, Revocable, User-controlled Evidence** · *"Your ID answers TRUE, nothing more."*
<!-- brand:end -->

Privacy-preserving verifiable identity network, built for CodeAstra 2.0 (PS1, Cybersecurity & Blockchain).
A student proves one fact (for example "I am over 18") to a verifier without showing the rest of their ID.

**Status:** rebuild part A done: one app with Person and Institution accounts, institutions issuing IDs by email, people accepting offers into a wallet, selective disclosure, revocation, an on-chain trust registry, three verifier instances behind a rate-limited front door. Part B (registers) is next. See `PLAN.md`.

## Run it

Needs Node 24 or newer.

```
npm install
npm run dev
```

`npm run dev` compiles the contract, starts the local chain (port 8545), deploys and seeds the registry, then starts the core API (4001), the verifier front door (4000) with three instances (4002, 4012, 4022), the app and the ops console.

| Window | Address |
|---|---|
| App (people and institutions; use Chrome Device Toolbar at 390px) | http://localhost:5176 |
| Ops console for the verifier servers | http://localhost:5175 |

Demo accounts (passwords are in `.env` as `DEMO_PASSWORD_INSTITUTIONS` and `DEMO_PASSWORD_PEOPLE`; generated on first start if missing):

| Institutions (verified) | People |
|---|---|
| astra@demo.true (Astra Institute of Technology, college) | aarav@demo.true |
| ironworks@demo.true (IronWorks Gym) | isha@demo.true |
| nimbus@demo.true (Nimbus Labs, company) | kabir@demo.true |

Other commands: `npm test`, `npm run chain:test` (contract tests), `npm run verify-institution -- <email>` (mark a new institution verified), `npm run reset` (wipe all demo data), `npm run brand`.
To try two accounts at once, use two browser profiles (or a normal and a private window): each has its own wallet.

## How it is built

- `packages/shared`: product name, addresses, credential templates and field names
- `packages/credentials`: the only place that touches cryptography in the browser and for credentials (a wrapper over libraries, no custom crypto)
- `packages/registry`: reads and writes the on-chain TrustRegistry (viem)
- `packages/wallet-core`: the wallet's storage and its accept / present flows, with no user interface
- `services/issuer-api`: the core API: accounts, institutions and their keys, offers, revocation (password hashing uses Node's scrypt)
- `services/verifier-api`: front door plus three verifier instances that share state
- `apps/app`: the app for people and institutions
- `apps/verifier-web`: ops console (instance status, kill / restart, rate limits, load test)
- `contracts`: the TrustRegistry contract and its tests (Hardhat)
- `docs/EXPLAIN.md`: plain-language explanation of every part

The verifier never calls the core API about a person or a credential. It checks signatures against the institution's key on the chain and reads revocation from its own cached copy of the public list (downloaded on a timer and checked against the hash on the chain).

On the chain: institutions (name, verified flag, public keys and their state), verifiers and what they may ask for, and the hash of the revocation list. No personal data.

## Known limitations (so far)

- All data is fake demo data.
- Unlinkability: selective disclosure hides claims, but the issuer's signature and the holder's public key are the same in every presentation, so two verifiers who compare notes could tell it is the same credential. A fix (issuing several one-time copies) is not built.
- Revocation takes effect at verifiers after their next scheduled refresh (5 seconds by default).
- The chain is a local development chain that starts empty on every run; the issuer re-publishes its keys from its database.
- Emails are not verified, there is no PIN or biometric step in the wallet, and the audit log is not hash-chained.
- A wallet lives on one device: logging in elsewhere shows an empty wallet.
- Each section of `docs/EXPLAIN.md` ends with its own honest limits.

## Attribution

Every third-party library used. All code in this repository was written during the event.

| Library | Used for | Licence |
|---|---|---|
| [@sd-jwt/sd-jwt-vc](https://github.com/openwallet-foundation-labs/identity-common-ts) (OpenWallet Foundation) | SD-JWT VC issue, present, verify | Apache-2.0 |
| [@owf/crypto](https://github.com/openwallet-foundation-labs/identity-common-ts) | ES256 sign/verify, SHA-256, salts | Apache-2.0 |
| [@owf/token-status-list](https://github.com/openwallet-foundation-labs/identity-common-ts) | Installed as a dependency of the SD-JWT library; our revocation list does not use it | Apache-2.0 |
| [jose](https://github.com/panva/jose) | Signed proof of key ownership at issuance | MIT |
| [Hono](https://github.com/honojs/hono) + @hono/node-server | HTTP APIs | MIT |
| [Zod](https://github.com/colinhacks/zod) | Request validation | MIT |
| [React](https://github.com/facebook/react) | User interfaces | MIT |
| [Vite](https://github.com/vitejs/vite) + @vitejs/plugin-react | Front-end dev server and build | MIT |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) + @tailwindcss/vite | Styling | MIT |
| [qrcode](https://github.com/soldair/node-qrcode) | Drawing QR codes | MIT |
| [Hardhat](https://github.com/NomicFoundation/hardhat) + hardhat-toolbox-viem | Local chain, contract compile and tests | MIT |
| [viem](https://github.com/wevm/viem) | Reading and writing the registry contract | MIT |
| [Vitest](https://github.com/vitest-dev/vitest), [TypeScript](https://github.com/microsoft/TypeScript) | Tests, type checking | MIT, Apache-2.0 |
| Node.js built-ins (`node:sqlite`, WebCrypto) | Database, key generation, randomness | — |

AI assistance: code was written with Claude Code (Anthropic) and reviewed by the team.
No third-party images, datasets or pre-trained models are used. Student photos are placeholder avatars generated by our own code.
=======
# TRUE
>>>>>>> 6cb48062ca13629d5865b01f46ba2e2cfae7f7c5
