<<<<<<< HEAD
<!-- brand:start -->
# TRUE

**Trusted, Revocable, User-controlled Evidence** · *"Your ID answers TRUE, nothing more."*
<!-- brand:end -->

Privacy-preserving verifiable identity network, built for CodeAstra 2.0 (PS1, Cybersecurity & Blockchain).
A student proves one fact (for example "I am over 18") to a verifier without showing the rest of their ID.

**Status:** working end to end: issue → wallet → consent → selective disclosure → live verification, with revocation, an on-chain trust registry, verifier authentication, three verifier instances behind a rate-limited front door, and a load test. See `PLAN.md` for what is not built.

## Run it

Needs Node 24 or newer.

```
npm install
npm run dev
```

Then open three browser windows:

| Window | Address |
|---|---|
| New app (mobile-first, phase 1: holder mode) | http://localhost:5176 |
| Issuer console | http://localhost:5174 |
| Wallet | http://localhost:5173 |
| Verifier | http://localhost:5175 |

`npm run dev` compiles the contract, starts the local chain (port 8545), deploys and seeds the registry, then starts the issuer API (4001), the verifier front door (4000) with three verifier instances (4002, 4012, 4022), and the three web apps.

Other commands: `npm test` (all tests), `npm run chain:test` (contract tests), `npm run reset` (wipe all demo data), `npm run spike` (smallest SD-JWT check), `npm run brand` (re-apply the product name to the Markdown headings).

Optional settings go in `.env` (see `.env.example`).

## How it is built

- `packages/shared`: product name, addresses, claim names
- `packages/credentials`: the only place that touches cryptography (a wrapper over libraries, no custom crypto)
- `services/issuer-api`, `services/verifier-api`: two separate APIs with separate SQLite databases
- `packages/wallet-core`: wallet storage and claim/present flows shared by the wallet apps
- `apps/app`: the new mobile-first app (role picker + holder mode so far)
- `apps/wallet`, `apps/issuer-web`, `apps/verifier-web`: the original three screens, kept until the new app reaches parity
- `packages/registry`: reads and writes the on-chain TrustRegistry (viem)
- `contracts`: the TrustRegistry contract and its tests (Hardhat)
- `docs/EXPLAIN.md`: plain-language explanation of every part

The verifier never asks the issuer about a person. It checks the credential's signatures against the issuer key on the chain, and reads revocation from its own cached copy of the issuer's public list (downloaded on a timer and checked against the hash on the chain).

On the chain: issuer public keys and their state, the verifier registry, and the hash of the revocation list. No personal data.

## Known limitations (so far)

- All data is fake demo data.
- Unlinkability: selective disclosure hides claims, but the issuer's signature and the holder's public key are the same in every presentation, so two verifiers who compare notes could tell it is the same credential. A fix (issuing several one-time copies) is not built.
- Revocation takes effect at verifiers after their next scheduled refresh (5 seconds by default).
- The chain is a local development chain that starts empty on every run; the issuer re-publishes its keys from its database.
- No PIN or biometric step in the wallet, no admin login on the issuer console, and the audit log is not hash-chained yet.
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
