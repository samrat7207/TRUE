<!-- brand:start -->
# TRUE — build plan

**Trusted, Revocable, User-controlled Evidence** · *"Your ID answers TRUE, nothing more."*
<!-- brand:end -->

Build plan for CodeAstra 2.0, PS1 (Privacy-Preserving Verifiable Identity Network).

Status: **proposal, awaiting approval. No code written yet.**
Source of truth for requirements is `PS1.md` (not edited). This file holds the plan and notes.

---

## 1. The problem in plain words

Today, to prove one small fact ("I am a student", "I am over 18"), you hand over a whole ID card.
The shop or library now holds your name, date of birth, photo and ID number, which they never needed. If they get hacked, all of it leaks.

We build a digital version of "show only the one line that matters":

- A **college (issuer)** gives the student a digitally signed ID.
- The student keeps it in a **wallet app (holder)** on their phone.
- A **library or venue (verifier)** asks one question, e.g. "are you over 18?".
- The wallet shows who is asking and what they want. The student taps approve.
- The verifier receives only that one answer plus maths proof that (a) the college really signed it, (b) this phone really owns it, (c) it is fresh and meant for this verifier, (d) it has not been cancelled.
- The college can **cancel (revoke)** an ID, and the verifier notices without phoning the college about a specific person.
- The wallet can tell a **real verifier from a fake one**.
- Everything important is written to a **log that cannot be silently edited**, with no personal data in it.
- A small **blockchain** holds only public things: who the issuers and verifiers are, fingerprints of the revocation list and of the log. Never personal data.

## 2. Assumptions

1. Team wants TypeScript end to end (PS1 §9 says "preferred"); still needs your yes.
2. Dev machine: Windows 11, Node v24.20.0, npm 11.19.0, git 2.54 (checked). Not yet a git repo.
3. Internet is available at the venue ("offline" = in-person), but slow: my npm lookups took 10–60 s each. We should install all dependencies once, early.
4. Demo data is fake. One fictional issuer ("Astra Institute of Technology"), two fictional verifiers ("City Library" asks `is_student`; "Nova Arena" asks `age_over_18`), plus one unregistered "fake" verifier for the phishing demo.
5. The chain is a local dev chain. It stands in for a public ledger; we treat it as public and put nothing personal on it.
6. Selective disclosure uses SD-JWT VC (salted hashes), not BBS+. Reason in §6.
7. We follow the *shape* of the OpenID4VCI / OpenID4VP flows (offer → credential; signed request → presentation) but do not claim conformance with those specs.
8. Signature algorithm is ES256 (ECDSA P-256) everywhere, because browsers support it natively through WebCrypto and can keep the private key non-exportable.
9. "PIN / biometric style step" in the base build is a wallet-local PIN gate. WebAuthn is held back as the stricter-auth pivot.
10. Polling (1 s) is good enough for the "verifier page updates live" requirement; SSE is polish.
11. Issuer and verifier each run their own backend with their own database and keys. They never call each other.

## 3. Open questions (most important first)

1. **Stack:** approve TypeScript everywhere — Node 24 + Hono APIs, React + Vite front ends, Solidity + Hardhat chain?
2. **Demo devices and network:** real phone as the wallet, or everything in browser windows on one laptop? A phone needs HTTPS (camera and WebCrypto only work on HTTPS or localhost), so we would need a tunnel or hosting.
3. **Timeline:** how many hours remain, and when do the Convergence Round and the pivot start? The milestone hours below assume a full 24.
4. **Chain depth:** is a local Hardhat chain enough, or do you want a public testnet for the hosted demo link? Can someone on the team defend ~100 lines of Solidity?
5. **Team split:** what are the other three comfortable with (React, backend, Solidity, docs/pitch)? I have proposed a split in §9.
6. **Hosting:** is a live demo link expected for this PS, and where (Render, Railway, Vercel)? A local chain cannot be reached from a hosted site.
7. **Unlinkability:** SD-JWT hides claims but two colluding verifiers could match the same signature. OK to document this honestly and mitigate with batch-issued one-time copies as a stretch goal?
8. **Scenario:** happy with student ID → library (`is_student`) and venue (`age_over_18`) as the two demo claims?

## 4. Architecture

```
                        ┌──────────────────────────────────────────┐
                        │  Local chain (Hardhat) — TrustRegistry   │
                        │  issuer keys + status │ verifier registry│
                        │  status-list hash     │ audit head hash  │
                        └───▲──────────▲─────────────▲─────────────┘
             writes keys,   │          │ reads       │ reads issuer keys,
             anchors        │          │ verifier    │ anchors; writes own
                            │          │ registry    │ audit anchor
┌────────────┐      ┌───────┴────┐   ┌─┴────────────┐   ┌──────────┴───┐      ┌─────────────┐
│ Issuer web │─────▶│ Issuer API │   │  Wallet PWA  │   │ Verifier API │◀─────│ Verifier web│
│ (admin)    │      │ :4001      │   │  (holder)    │   │ :4002        │      │ (kiosk+ops) │
└────────────┘      └─────▲──┬───┘   └──┬───────▲───┘   └───▲──────▲───┘      └─────────────┘
                          │  │ 1 offer  │       │ 3 signed  │      │
                          │  └─────QR──▶│       │  request  │      │ partner teams
                          │ 2 credential│       └───QR──────┘      │ (Convergence)
                          └─────────────┘  4 presentation ─────────┘
                    status list (public, signed) ──────────────────▶ fetched by verifier
```

Key rule shown in the picture: there is **no arrow between Issuer API and Verifier API**. The verifier learns issuer keys and revocation anchors from the chain, and fetches the public status list as a whole file.

### Issuance flow (shape of OpenID4VCI, no conformance claim)
The issuer database is the source of truth for who may receive a credential (see §4.2).
1. Admin clicks "Issue credential" on a student row in Issuer web → `POST /v1/claim-codes` → a one-time, short-lived claim code shown as text and as a QR offer.
2. Wallet creates a P-256 key pair on the device (private key non-exportable, stored in IndexedDB).
3. Wallet scans the offer or the user types the code. Wallet sends the code, its public key and a signed proof over the issuer's nonce (proves it owns the key).
4. Issuer looks up the code and its student row. It issues only if the code exists, is unexpired and unused, and the student is `active`. Otherwise it refuses with a reason code and logs `issuance.refused`.
5. On success, in one DB transaction: allocate `status_list_index`, store it on the student row, mark the code used. Then return an SD-JWT VC: every claim individually salted and hashed, holder public key inside (`cnf`), status-list index inside (`status`), signed with the issuer key.

The wallet has no screen for typing credential data. The only way a card appears is this flow.

### Revocation flow
1. Admin clicks "Revoke" on a student row and enters a reason → `POST /v1/students/{id}/revoke`.
2. Issuer sets `status = revoked`, flips that student's bit in the status list, re-signs the list, and writes the new list hash to the chain.
3. Audit event `credential.revoked` records a salted reference, the status index and a reason *code*. No name, PNR or free text.

### 4.2 What the databases do, and deliberately do not do
**Issuer DB does:** decide who is eligible (student row exists and is active), hold the raw records and photo, track claim codes, remember each student's status-list index, keep the issuer's audit log.
**Issuer DB does not:** get queried at verification time, get copied to the chain, appear in audit logs, or hold the holder's private key.

**Verifier DB does:** hold this verifier's own config (name, allowed claims, signing key), its requests, results, used nonces and audit log.
**Verifier DB does not:** store student records, share anything with the issuer DB, or keep undisclosed claims (it never receives them).

**Hard rules (each enforced by a test or a structural check):**
- Verification uses only three inputs: the credential's signature, the downloaded status list, and the chain registry. `verifier-api` has no issuer URL in its config except the public status-list URI that is read from inside the credential.
- DOB, address and photo exist in two places only: the issuer DB and the holder's wallet. Never on-chain, never in an audit event.
- Wallet accepts credentials only from the issuance flow above.

### Presentation flow
1. Verifier web → `POST /v1/requests` (policy = which claims) → QR containing a `request_uri`.
2. Wallet fetches the **signed request JWT**: verifier id, requested claims, purpose, nonce, response URL, expiry.
3. Wallet checks the request signature against the verifier's key in the on-chain registry → shows "Verified verifier: City Library" or a red warning.
4. Consent screen: asked for / will NOT be shared. User enters PIN.
5. Wallet sends SD-JWT with only the chosen disclosures + a key-binding JWT (signed by holder key, contains nonce, audience = verifier id, hash of the presentation).
6. Verifier runs the check pipeline (§4.1) and stores the result; verifier web polls and flips to Verified / Denied.

### 4.1 Verification pipeline (ordered small functions, one file each)
1. Parse and shape check
2. Issuer key lookup in registry; key must be `active` (not `compromised` / `retired`)
3. Issuer signature
4. Disclosures match the signed hashes
5. Holder key-binding signature against `cnf`
6. Nonce matches an open request and is unused (then burned)
7. Audience equals this verifier
8. Time window (credential expiry, key-binding freshness)
9. Status list: fetch, check its hash equals on-chain anchor, read the bit
10. Policy: disclosed claims satisfy the request

Each step returns pass/fail with a reason code. This is deliberately a list so a "patch a vulnerable step" pivot is one file plus one test.

## 5. Data model

**Credential (SD-JWT VC payload, off-chain, lives only in the wallet)**
`iss` (issuer id), `vct` ("StudentCredential"), `iat`, `exp`, `cnf.jwk` (holder public key), `status.status_list {idx, uri}`, `_sd` (hashes of hidden claims).
Disclosable claims, raw: `name`, `pnr`, `dob`, `address`, `class`, `section`, `branch`, `photo`, `institution`.
Disclosable claims, derived by the issuer at signing time: `is_student`, `age_over_18`, `age_band`.
Verifier policies in the demo ask only for derived claims, so the raw ones stay in the wallet.

**Issuer DB (SQLite)**
- `students(id, name, pnr, dob, address, class, section, branch, photo, status[active|revoked], revoked_reason, status_list_index, created_at)` — seeded with ~8 fake students. `photo` is a small placeholder avatar we generate ourselves (initials on a coloured square, SVG data URI), so there is no third-party image to cite.
- `claim_codes(code, student_id, nonce, created_at, expires_at, used_at)` — one-time, 10-minute life
- `status_lists(id, bits, version, updated_at)`
- `issuer_keys(kid, public_jwk, private_jwk_encrypted, state)`
- `audit_events(seq, ts, type, subject_ref, data_json, prev_hash, hash)`

**Verifier DB (SQLite, separate file and process from the issuer's)**
- `verifier_config(id, name, allowed_claims_json, public_jwk, private_jwk_encrypted)` — mirrors this verifier's on-chain registry entry
- `policies(id, name, claims_json, purpose, required_assurance)`
- `requests(id, policy_id, nonce, state[pending|verified|denied|expired], created_at, expires_at, result_json)`
- `used_nonces(nonce, used_at)`
- `risk_signals(id, source, subject_ref, score, reason, ts)` — for the AI convergence
- `audit_events(…same shape…)`

**Wallet (IndexedDB, on device)**
- `keys` (non-exportable CryptoKey), `credentials` (raw SD-JWT + parsed view), `history` (who asked what, when, decision), `settings` (PIN hash, salt)

**On-chain (`TrustRegistry.sol`)**
- `issuers[issuerId] → {name, keys[kid] → {publicKeyHash/JWK, state: Active|Retired|Compromised}}`
- `verifiers[verifierId] → {name, publicKey, allowedClaims[], active}`
- `statusAnchors[issuerId][listId] → {hash, version, updatedAt}`
- `auditAnchors[actorId] → {headHash, seq, updatedAt}`
- Events emitted for every change. Owner-only writes for the registry admin; each issuer writes only its own anchors.

**Audit event**
`{seq, ts, type, actor, subject_ref, data, prev_hash, hash}` where `hash = SHA-256(prev_hash ‖ canonical JSON of the rest)`.
`subject_ref` is a salted hash, never a name or ID. Types: `credential.issued`, `request.created`, `consent.given`, `consent.denied`, `presentation.verified`, `presentation.failed`, `credential.revoked`, `key.rotated`, `anchor.published`.

## 6. API contract (v1, OpenAPI generated from the same schemas the code validates with)

**Issuer API — `http://localhost:4001/v1`**
| Method | Path | Purpose |
|---|---|---|
| GET | `/students` | Admin: list students with status |
| POST | `/claim-codes` | Admin: create one-time claim code + QR offer for a student (404 if student unknown, 409 if revoked) |
| GET | `/claim-codes/{code}` | Wallet: offer details + nonce |
| POST | `/credentials` | Wallet: send code + holder key + proof, receive SD-JWT VC. Refusals: `unknown_code`, `code_expired`, `code_used`, `student_not_active` |
| POST | `/students/{id}/revoke` | Admin: revoke with reason (flips status bit, re-anchors) |
| GET | `/status-lists/{id}` | Public: signed status list token (cacheable) |
| POST | `/keys/rotate` | Admin: new signing key, old one Retired or Compromised |
| GET | `/audit/events`, `/audit/verify` | Operator: log and chain check |
| GET | `/.well-known/issuer` | Public metadata |

**Verifier API — `http://localhost:4002/v1`** (this is what Convergence partners call)
| Method | Path | Purpose |
|---|---|---|
| POST | `/requests` | Create a presentation request → `{requestId, requestUri, qrPayload, expiresAt}` |
| GET | `/requests/{id}/object` | Wallet: the signed request JWT |
| POST | `/requests/{id}/response` | Wallet: submit presentation (or a decline) |
| GET | `/requests/{id}` | Poll result: `pending / verified / denied / expired` + disclosed claims + failed check code |
| POST | `/verify` | Stateless: verify a presentation given nonce + audience (for partner back ends) |
| GET | `/status/{issuerId}/{listId}/{idx}` | Check a status bit |
| GET | `/events?after={seq}` | Audit stream, no personal data (AI team consumes this) |
| POST | `/risk-signals` | Accept a risk score back from an AI team |
| GET | `/policies`, `/audit/verify`, `/openapi.json`, `/docs` | Supporting |

Partner calls use an `X-API-Key`. All errors share one shape: `{error: {code, message}}`.

## 7. Libraries

Checked on the npm registry on 2026-10-12: package exists, latest version, last publish date, licence, deprecation flag.
**I have not installed or run any of them yet**, so API details are unconfirmed until the M0 spike.

| Library | Version seen | Why |
|---|---|---|
| `@sd-jwt/sd-jwt-vc` (+ `@sd-jwt/core`) | 0.22.0, published 2026-10-09, Apache-2.0 | OpenWallet Foundation SD-JWT VC: issue, present, verify, key binding. The core of selective disclosure. |
| `@owf/token-status-list` | 0.4.2, 2026-10-07, Apache-2.0 | Bit-string status list for revocation (IETF Token Status List). Already a dependency of the package above. |
| `@owf/crypto` | 0.4.2, 2026-10-07, Apache-2.0 | Hash/sign helpers for SD-JWT in browser and Node. |
| `jose` | 6.2.12, 2026-09-05, MIT | Signed verifier requests, JWK handling, key thumbprints. |
| `hono` + `@hono/node-server` | 4.13.13 / 2.1.4, Oct 2026, MIT | Small, readable HTTP framework; easy to explain line by line. |
| `@hono/zod-openapi` + `zod` | 1.6.3 / 4.6.6, MIT | One schema gives validation and the OpenAPI file, so docs cannot drift. |
| `@scalar/hono-api-reference` | 0.12.11, 2026-10-07, MIT | Browsable API docs page for partners and jury. |
| `node:sqlite` (built into Node) | Node 24.20 | Database with nothing to install; I ran it on this machine and it works. |
| `hardhat` + `@nomicfoundation/hardhat-toolbox-viem` | 3.19.0 / 5.0.7, Oct 2026, MIT | Local chain, compile, test and deploy the one contract. |
| `viem` | 2.57.4, 2026-10-08, MIT | Read/write the contract from Node and from the wallet. |
| `react` + `vite` | 19.3.0 / 8.3.3, Oct 2026, MIT | Front ends; `npm create vite` is allowed standard scaffolding. |
| `vite-plugin-pwa` | 2.0.0, 2026-10-03, MIT | Makes the wallet installable (manifest + service worker). |
| `tailwindcss` + `@tailwindcss/vite` | 4.3.3, MIT | Fast, consistent styling for the UI/UX marks. |
| `qrcode` | 1.5.4, last publish 2024-08, MIT | Draw QR codes. Old but stable and tiny in scope. |
| `@yudiel/react-qr-scanner` | 2.6.0, 2026-05, MIT | Scan QR codes with the camera in React. |
| `vitest` | 5.0.3, MIT | Tests for each PS1 "Test:" line. |
| `@simplewebauthn/browser` + `/server` | 14.0.0 / 14.0.3, Sept 2026, MIT | Only for the stricter-auth pivot (WebAuthn). |

### Honest flags
- **SD-JWT packages are mid-migration.** `@sd-jwt/core` and `@sd-jwt/sd-jwt-vc` now publish from a new repo (`openwallet-foundation-labs/identity-common-ts`). The helpers I knew, `@sd-jwt/crypto-browser`, `@sd-jwt/crypto-nodejs` and `@sd-jwt/jwt-status-list`, are **marked deprecated** on npm ("merged into `@owf/crypto`", "moved to `@owf/token-status-list`"). I have not used the `@owf/*` packages and cannot vouch for their API. They are version 0.x. First task of M0 is a 30-line spike that issues, presents and verifies one credential. Fallback: `@sd-jwt/core` accepts our own hasher/signer callbacks, which we would fill with the platform's WebCrypto (still no custom cryptography).
- **Hardhat 3 is a different major version from the Hardhat 2 most tutorials show** (ESM-only, viem-first, new config format). I have not confirmed its exact config or the toolbox pairing. Fallback if it costs more than 45 minutes: pin Hardhat 2 or use Foundry's `anvil`.
- **IETF Token Status List vs W3C Bitstring Status List.** PS1 names the W3C one. The IETF one is the same idea (compressed bit array, one bit per credential) and is the native fit for SD-JWT. `@digitalbazaar/bitstring` (the W3C-style helper) was last published in January 2023, so I do not recommend it.
- **BBS+ not recommended.** `@mattrglobal/bbs-signatures` 2.0.0 was last published September 2024 and predates the current standard draft. I could not find a maintained, standard-tracking BBS library in TypeScript that I would trust in 24 hours.
- **Rejected for staleness:** `html5-qrcode` (2023-04), `qr-scanner` (2022-11).
- **`better-sqlite3`** exists and is maintained (13.0.3) but needs a native build on Windows; `node:sqlite` avoids that risk.
- I checked registry metadata only. I did not check GitHub issue activity, download counts or security advisories.

## 8. Folder structure and modules

```
codeastra-ps1/
├─ README.md                 setup, design overview, stack, Attribution
├─ PLAN.md  PS1.md
├─ package.json              npm workspaces
├─ docs/
│  ├─ trust-assumptions.md   key-recovery.md   threat-model.md
│  ├─ onchain-vs-offchain.md limitations.md
│  └─ openapi/issuer.v1.json  verifier.v1.json   (generated, committed)
├─ contracts/                TrustRegistry.sol, tests, deploy script
├─ packages/
│  ├─ shared/                zod schemas, claim names, error codes, config
│  ├─ credentials/           thin wrapper over SD-JWT: issue / present / verify
│  ├─ registry-client/       viem reads and writes for TrustRegistry
│  ├─ status-list/           build, sign, read bit, hash
│  └─ audit/                 append event, verify chain, head hash
├─ services/
│  ├─ issuer-api/            routes/ db/ keys/ seed/
│  └─ verifier-api/          routes/ db/ pipeline/ (one file per check) policies/
├─ apps/
│  ├─ wallet/                PWA: cards, scan, consent, PIN, history, key store
│  ├─ issuer-web/            subjects, issue, revoke, rotate key, audit
│  └─ verifier-web/          kiosk (QR + live result), operator audit view
└─ scripts/                  dev-all, seed, demo-attacks (replay, wrong audience, tamper)
```

Rule: all cryptography goes through `packages/credentials`. Apps and services never call a crypto library directly. That gives one place to explain, test and patch.

## 9. Milestones (hours from start; adjust once Q3 is answered)

| # | Hours | Goal | Done when |
|---|---|---|---|
| M0 | 0 – 1.5 | `git init`, workspaces, install everything once, **SD-JWT spike**, Hardhat hello-world | Spike script prints "verified" and "tampered → rejected" |
| M1 | 1.5 – 6 | **End-to-end demo**: issue → wallet card → verifier QR → consent → one claim disclosed → live Verified. Keys from a local file, no chain yet | PS1 tests 5.2, 5.3, 5.4, 5.5 pass (tamper, replay, wrong audience, hidden claims absent). Issuer DB seeded with 8 fake students; tests `unknown student refused` and `reused claim code refused` pass; both are buttons in the demo. Test `revoked student's credential fails verification` is written in M1 and goes green in M2 when the status list lands |
| M2 | 6 – 9 | **Revocation**: status list, `TrustRegistry` deployed, issuer keys and status anchor on chain | Verify OK → revoke → same credential fails, live |
| M3 | 9 – 11.5 | **Verifier authentication**: signed requests, on-chain verifier registry, wallet badge/warning, over-asking flag | Fake and tampered verifier requests are blocked in the wallet |
| M4 | 11.5 – 14 | **Audit log**: hash chain in both services, wallet history, operator view, on-chain head anchor, `/events` | Editing one DB row makes `/audit/verify` fail |
| M5 | 14 – 18 | **Polish**: UI pass, PWA install, PIN, key rotation screen, attack-demo buttons, empty and error states | Full demo script runs clean twice |
| M6 | 18 – 21 | **Docs + deploy**: README, the five docs, Attribution, OpenAPI export, hosting | A teammate sets up from README alone |
| M7 | 21 – 24 | Buffer, rehearsal, code freeze | — |

Convergence and pivot arrive at times we do not control; they will eat into M5–M7, which is why M1–M4 are front-loaded.

**Suggested split (4 people):** A = main builder with Claude Code (packages + services). B = wallet PWA UI. C = contract + issuer/verifier web. D = docs, threat model, demo script, pitch, and reading every merged block so the team can defend it.

## 10. Where Convergence and the pivot plug in

**Convergence Round** — everything goes through versioned `/v1` on the Verifier API, documented at `/docs`.
- *Web team:* calls `POST /requests`, `GET /requests/{id}` (or stateless `POST /verify`) to add "prove you are a student" to their own onboarding flow.
- *AI team:* reads `GET /events?after=` (hashed identifiers only), sends scores to `POST /risk-signals`. The verifier's policy step can deny or require step-up when risk is high, so their output changes a real decision.
- *IoT team:* the device holds the holder key. The existing key-binding check is already proof of possession; we add a credential type `DeviceCredential` with a `device_id` claim. No new crypto.

**Pivot A, stricter authentication** — three prepared hooks:
- `required_assurance` column on verifier policies and an `assurance` field in the signed request (present from M3, value `pin`).
- Wallet has a single `stepUp(level)` function before signing; the pivot adds a WebAuthn branch there.
- Key-binding JWT carries which method was used; pipeline step 10 compares it with the policy.
- Limitation to say out loud: the verifier is trusting the wallet's statement of which method was used, unless the passkey is also registered with the issuer.

**Pivot B, zero-day / key compromise** — four prepared hooks:
- Issuer keys on chain have a `state` (Active / Retired / Compromised) and a `kid` from M2; `POST /keys/rotate` exists from M5.
- Pipeline step 2 already rejects `Compromised` keys; wallet shows a warning on cards signed by one.
- Emergency revocation = mark key compromised (one transaction kills every credential under it) or flip bits in the status list.
- A vulnerable verification step is patched by editing one file in `verifier-api/pipeline/` and adding one regression test.

## 11. Notes for the required documentation (to expand in M6)

- **Unlinkability limit:** with SD-JWT the issuer signature and holder key are the same in every presentation, so colluding verifiers could link a user. Mitigation: issue a batch of one-time copies with different holder keys (stretch). The status index is also a stable number; same mitigation.
- **Status privacy:** the verifier downloads the whole list, so the issuer cannot tell which credential was checked.
- **Key recovery:** holder key is non-exportable by design, so a lost phone means re-verification and re-issuance by the issuer plus revocation of the old credential. Issuer key leak means rotate, mark compromised on chain, re-issue.
- **Secure context:** WebCrypto and the camera need HTTPS or localhost. This decides the phone-demo setup (Q2).

## 12. Build log and defaults chosen (no need to re-decide)

**Decisions from the owner (after approval):** solo coder; about 17 hours; local chain only, contract under ~100 lines; no hosting, one command to run; all three roles as browser windows on one laptop; scenario = City Library (name + photo + PNR), Nova Arena (age_over_18), Campus Store (is_student), one unregistered fake verifier (M3); verifier fetches the status list on a schedule and caches it, never per verification (M2).

**M0 done.** Hardhat 3 worked inside the time box (no fallback needed). The `@owf/*` SD-JWT packages work.

**M1 done.** Defaults I picked:
- Plain Hono routes with Zod checks instead of `@hono/zod-openapi`: about half the code and easier to defend. The OpenAPI file will be written by hand in M6. `@scalar/hono-api-reference`, `vite-plugin-pwa`, `@yudiel/react-qr-scanner` and `@simplewebauthn/*` are not installed yet; each gets installed only when its milestone is reached.
- Added `@vitejs/plugin-react` (the standard React plugin that `npm create vite` installs). It was not in the original list.
- One verifier-api process hosts all three demo verifiers (table `verifiers`), to keep "one command". Audience binding still uses each verifier's own id.
- A genuine credential that answers "No" to a requested yes/no claim is **denied** (`requirement_not_met`), not shown as verified.
- `age_band` dropped; `is_student` and `age_over_18` are the derived claims.
- Claim code: 8 characters, 10 minutes, one use. Request: 5 minutes. Presentation freshness: 5 minutes. Credential: 365 days.
- Until M2, the issuer public key is published to `data/registry.json` (public keys only) as a stand-in for the chain.
- Node runs the TypeScript files directly (built into Node 24), so there is no build step for the APIs.
- QR codes contain a wallet link; on one laptop the "Open in wallet" button does the same job. Camera scanning waits for the phone demo.
- Not in M1 on purpose: PIN, audit log, signed verifier requests, revocation, admin login for the issuer screen.

**Convergence done (built alone, no other team's code or services).**
- Verifier runs as two instances (4002, 4012) with separate database files, behind a front door on 4000 that health-checks every 2 seconds. `URLS.verifierApi` now points at 4000.
- `/internal/sync` shares requests, revocation bits and audit events; protected by `INTERNAL_SYNC_KEY` from `.env` (see `.env.example`; a random key is made for the run if `.env` is missing).
- Merge rules: revocation bits OR; requests by id, latest `updated_at` wins; audit events unique by id. Disclosed claims are never shared.
- Verifier databases were renamed to `verifier-1.db` / `verifier-2.db` (new columns); the old `verifier.db` is unused.
- Added a minimal verifier audit table and a status-bit store ahead of M2/M4 so the merge rules are real. Verification does not consult the status bits yet.
- Verifier screen: instance status panel and Kill / Restart instance 1 button.

**Convergence upgrade done.** Instance count configurable (`VERIFIER_INSTANCES`, default 3: ports 4002/4012/4022). Front door does round-robin among alive instances with `X-Served-By`, retries on another instance, and returns a friendly 503 when none are alive. Sync fans out to all peers; restart pulls from any live peer. Verifier screen has a card per instance with its own Kill/Restart, plus Kill all / Restart all, a "Served by" badge and a "No server available" state.
