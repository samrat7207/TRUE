<!-- brand:start -->
# TRUE — how each part works, in plain words

**Trusted, Revocable, User-controlled Evidence** · *"Your ID answers TRUE, nothing more."*
<!-- brand:end -->

This file is for the team: short explanations we can repeat to the jury. One section per building block, added as we build it.

---

## The databases: what they do, and what they deliberately do not do

### The idea in one line
The issuer's database decides **who may get a credential**. After that, the credential stands on its own: nobody needs the database to check it.

A paper comparison: the college office keeps a register of students. You must be in the register to be handed an ID card. But the guard at the library gate does not phone the office each time; the guard looks at the card's seal and at a public notice board of cancelled cards.

### Issuer database (SQLite, owned by the college)

| Table | What it holds | Why |
|---|---|---|
| `students` | id, name, PNR, date of birth, address, class, section, branch, photo thumbnail, status (active/revoked), status-list index, created-at | The source of truth. Seeded with about 8 fake students and placeholder photos |
| `claim_codes` | a one-time code, which student it is for, when it expires, when it was used | The "ticket" that lets one wallet collect one credential |
| `status_lists`, `issuer_keys`, `audit_events` | the revocation bit list, the signing keys, the log | Supporting |

### How a credential is issued
1. In the issuer screen the admin clicks **Issue credential** on a student. The issuer creates a short-lived one-time code and shows it as text and as a QR offer.
2. The wallet makes its own key pair on the device. The private key never leaves the device.
3. The wallet scans the QR (or the user types the code) and sends two things: the code and its public key.
4. The issuer checks, in this order: does this code exist? is it unexpired? is it unused? is the student still active?
5. All yes → the issuer signs a credential tied to that wallet's public key, marks the code used and saves the student's status-list index. Any no → it refuses and logs the refusal.

So these people get nothing: someone not in the database, someone with an expired code, someone reusing a code, and a student who has been revoked.

There is no way to type credential data into the wallet. A card can only arrive through the steps above.

### How revocation works
1. The admin clicks **Revoke** and picks a reason.
2. The issuer marks the student `revoked`, flips that student's bit in the status list, signs the new list, and writes the list's fingerprint (hash) to the chain.
3. The audit log records "a credential was revoked", with a scrambled reference and a reason code. No name, no PNR.

### Verifier database (SQLite, owned by the library or venue, completely separate)
It holds the verifier's own name, allowed claims and key, the requests it created, the results, and its audit log. It holds no student records.

### What the databases deliberately do NOT do

| Rule | Reason | How we can prove it |
|---|---|---|
| The verifier never asks the issuer's database or API "is this person valid?" | If it did, the college would learn where and when each student shows their ID. It would also make the college a single point of failure | The verifier uses only three things: the signature on the credential, the downloaded status list, and the chain registry. Demo: stop the issuer API's student and credential routes and verification still works |
| Date of birth, address and photo never go on the chain | A public ledger cannot be erased | The contract has no field that could hold them; it stores keys, registry entries and hashes only |
| Personal data never goes in audit logs | Logs get copied, exported and shared with partner teams | Events carry a salted hash reference and codes, checked by a test that scans every event for student field values |
| The wallet accepts no hand-typed credentials | A credential is only worth something if the issuer signed it | No such screen exists; an unsigned or edited credential fails the signature check |
| The verifier stores only the claims that were disclosed | It never receives the rest | Inspect the presentation payload in the demo |

### One honest note
The verifier does download the status list file from a public issuer URL. That is not a lookup about a person: it is the same whole file for everyone, it can be cached, and its fingerprint is checked against the chain, so the issuer cannot tell which student is being checked or lie about the list.

### Tests for this section
1. **Unknown student refused** — a claim code cannot be created for a student id that is not in the database, and a made-up code gets no credential.
2. **Reused claim code refused** — the first use returns a credential; the second use of the same code is refused.
3. **Revoked student's credential fails verification** — verify succeeds, issuer revokes, the same credential now fails at the status check.


---

## M0 + M1: the first working loop

### What exists now
| Piece | Where | What it does |
|---|---|---|
| Brand | `packages/shared/src/brand.json` | The one place the name, full form and tagline live. Screens import it; `npm run brand` copies it into the Markdown headings |
| Crypto wrapper | `packages/credentials/src/index.ts` | The only file that touches cryptography. It calls libraries; it implements none |
| Issuer API | `services/issuer-api` (port 4001) | Student register, claim codes, signs credentials |
| Verifier API | `services/verifier-api` (port 4002) | Creates requests with a nonce, checks presentations, stores results |
| Wallet | `apps/wallet` (port 5173) | Holds the key and the credential, shows consent, sends only approved claims |
| Issuer screen | `apps/issuer-web` (port 5174) | Student list, "Issue credential", QR offer |
| Verifier screen | `apps/verifier-web` (port 5175) | Pick a verifier, show QR, live result |

### The credential in one paragraph
The issuer does not sign the claims directly. For each claim it makes a small packet `[random salt, claim name, value]`, hashes it, and signs the **list of hashes** together with the holder's public key. The wallet keeps all the packets. To reveal a claim, the wallet hands over that packet; the verifier hashes it and finds the hash in the signed list. Claims that are not revealed are only hashes of salted values, so they cannot be guessed. This format is called SD-JWT VC.

### The three proofs the verifier gets
1. **The issuer signed it**: the signature over the hash list verifies with the issuer's public key from the registry.
2. **This wallet owns it**: the wallet signs a short note with its private key, and the matching public key is inside the signed credential. A copied credential is useless without the key, and the key cannot be exported from the browser.
3. **It is fresh and for me**: that note contains the verifier's one-time nonce and the verifier's id. A different nonce or id fails.

### How each attack fails (each one is a test in `tests/m1.test.ts`)
| Attack | What stops it | Code returned |
|---|---|---|
| Change a disclosed value (false to true) | Its hash no longer matches the signed list | denied |
| Credential signed by someone else's key | Signature does not verify with the registry key | `bad_signature` |
| Send the same presentation again | Request is already answered; a new request has a new nonce | `request_already_answered` / `nonce_mismatch` |
| Send a proof made for another verifier | The id inside the signed note is wrong | `wrong_audience` |
| Present a copied credential with another key | The note is not signed by the key in the credential | denied |
| Person not in the database asks for a credential | No student row, so no code | `unknown_student` / `unknown_code` |
| Use a claim code twice | Code is marked used before signing | `code_used` |
| Genuine credential that says "No" | Policy check: a requested yes/no claim must be Yes | `requirement_not_met` |

### Why derived claims
`is_student` and `age_over_18` are separate yes/no facts computed by the issuer when it signs. Nova Arena asks only for `age_over_18`, so the date of birth never leaves the wallet.

### What is temporary in M1 (be ready to say this)
- Issuer public key is read from `data/registry.json`, a stand-in for the chain. M2 moves it on-chain.
- Verifier requests are not signed yet, so the wallet shows "verifier identity is not checked yet". M3 fixes this.
- No revocation yet. The student row already stores a status-list index; M2 uses it.
- The QR codes hold a link. On one laptop we click "Open in wallet" instead of scanning.
- No PIN, no audit log, no admin login on the issuer screen yet.


---

## Convergence: two verifier instances that survive one dying

### The picture
```
wallet / verifier screen  ->  front door :4000  ->  instance 1 :4002 (verifier-1.db)
                                                ->  instance 2 :4012 (verifier-2.db)
                              instance 1  <-- /internal/sync -->  instance 2
```
Files: `services/verifier-api/src/proxy.ts` (front door), `sync.ts` (merge rules), `server.ts` (one instance).

### How it works
- **Front door** asks each instance `/health` every 2 seconds and forwards every call to one that is alive. If a forward fails, it tries the other instance straight away.
- **Sharing:** after an instance creates a request, records a result, or gets new revocation bits, it POSTs the change to the other instance's `/internal/sync`. That endpoint needs the secret `INTERNAL_SYNC_KEY` from `.env`, and the front door refuses to forward anything under `/internal`.
- **Catch-up:** when an instance starts, it reads the other one's full state once.

### Merge rules (why repeats are harmless)
| Data | Rule | Why |
|---|---|---|
| Revocation bits | bitwise OR | a revoked credential can never become valid again by merging |
| Requests | same id: the newer `updated_at` wins; equal or older is ignored | a result replaces "pending", never the reverse |
| Audit events | insert by id, ignore if already there | a union without duplicates |

### What is NOT shared
Disclosed claim values (name, photo, PNR) are removed before sending. The other instance learns "request X was verified", not what was shown. Consequence: if the instance that verified dies afterwards, the survivor reports Verified without the claim values.

### Honest limits
- Two instances on one laptop: this shows failover, not real distribution. There is no consensus protocol; two answers to the same request arriving on both instances in the same millisecond is not handled.
- Revocation bits are stored, shared and merged, but the verification step does not read them until M2 puts a status index inside the credential.
- After a restart the panel says "not synced yet" until the next change, even though catch-up happened.
- Built by us; no other team's code or service is used.

### Tests (`tests/convergence.test.ts`)
Kill instance 1 mid-request then approve through instance 2 = verified; cross-instance replay refused; shared data has no claims; revocation on one appears on the other and survives merging old data; same events merged twice = no duplicates; sync without the key = 403.

### Upgrade: three instances, round-robin
- `VERIFIER_INSTANCES` (default 3) sets how many run: ports 4002, 4012, 4022 with `verifier-1.db`, `-2.db`, `-3.db`. Front door stays on 4000.
- The front door sends each request to the next alive instance in turn and adds the header `X-Served-By: instance N`. If a forward fails it tries another alive instance. With none alive it answers 503 `no_server_available`, and the 2-second health check brings service back as soon as one instance returns.
- Each instance sends every change to **all** peers at the same time and ignores the ones it cannot reach. Merge rules are unchanged.
- A restarted instance pulls the full state once from the first live peer; if no peer is alive it carries on from its own database file. "Last synced" is set at that pull, so it is correct after a restart.
- Because disclosed claims are never copied between instances, only the instance that did the check holds them. The verifier page keeps polling a few more times after "verified" until the round-robin reaches that instance, and never replaces an answer that has claims with one that does not.
- Tests added: create on 1, kill 1 and 2, approve through 3 = verified; kill all then restart one = it still has its requests from its own database file.


---

## M2: revocation and the chain registry

### What is on the chain (`contracts/contracts/TrustRegistry.sol`, 87 lines)
| On-chain item | Why it is there |
|---|---|
| Issuer public keys with a state: Active, Retired, Compromised | A verifier can check a signature, and learn a key leaked, without calling the issuer |
| Verifier registry: name, allowed claims, public key | A wallet can tell a real verifier from a fake one |
| Fingerprint (hash) and version of each issuer's revocation list | A verifier can tell the list it downloaded is the genuine, current one |

Nothing else. No names, no PNRs, no credentials, not even the revocation list itself: only its hash.
Only the registry owner can add issuers and verifiers. Only an issuer's own admin account can change that issuer's keys or fingerprint.

### How revocation works now
1. Every credential carries a position number in the issuer's revocation list (`revocation.idx`). A position number is not personal data.
2. Issuer clicks **Revoke** and picks a reason code. The student's bit flips to 1, the list version goes up, and the new fingerprint is written to the chain.
3. Each verifier instance downloads the whole public list every few seconds (`STATUS_REFRESH_SECONDS`, default 5). It accepts the list **only if its SHA-256 equals the fingerprint on the chain**, then ORs the bits into its own copy and shares them with the other instances.
4. During a verification the verifier reads only its cached copy. If the bit is 1 the answer is **Revoked**.

So the issuer never learns which student is being checked (everyone downloads the same whole file, on a timer), and a fake or stale list is ignored.
Honest limit: there is a delay of up to one refresh interval between Revoke and verifiers refusing.
Honest limit: our list is a plain hex bit list with a chain anchor, the same idea as the IETF Token Status List but not that exact format.

### Issuer keys
- **Rotate key:** new key becomes Active, the old one Retired. Old credentials keep working.
- **Mark compromised:** the key leaked. Verifiers read the key state from the chain on every check and reject everything it signed (`issuer_key_compromised`). Students must be re-issued under the new key. On the chain a compromised key can never be restored, and a key id can never be reused.

### Because the local chain is wiped on every restart
`npm run dev` compiles the contract, starts the chain, and runs `scripts/chain-setup.ts`, which deploys and seeds only what is missing. The issuer then re-publishes its keys and current fingerprint from its own database. `npm run reset` wipes all demo state.

## M3: verifier authentication

1. The verifier signs each request with its own private key (`signRequest`).
2. The wallet reads who the request claims to be from, looks that id up **in the chain registry**, and checks the signature with the registered public key (`authenticateRequest`). The name on screen comes from the registry, never from the request.
3. Three outcomes:
   - **Verified** (green): show the consent screen.
   - **Unregistered** (red): nobody registered that id. Approve does not exist; nothing is sent.
   - **Tampered** (red): the id is registered but the signature does not match its key.
4. **Purpose rule:** each verifier is registered for specific claims. If a correctly signed request asks for more, the wallet lists the extra claims in an amber warning and blocks Approve.

Demo: "Free Prize Booth" is a verifier with a key that was deliberately not registered. The "over-ask" switch on the verifier page makes the next request also ask for the home address.
Honest limit: the wallet reaches the chain through its own dev server (`/chain`), which is fine on one laptop; a real wallet would use a public RPC node.

## Rate limiting (front door)

| Limit | Rule | Answer when hit |
|---|---|---|
| Failed verification attempts | 5 failures in 60 s from the same source (IP address + verifier) blocks that source for 60 s | HTTP 429, `Retry-After` header, "Too many attempts, try again in N seconds" |
| Request creation | 120 per minute per API key or IP address | HTTP 429 `too_many_requests` |

- A failure is an error reply or a denied presentation. Pressing Decline is not a failure.
- The limiters are two small Maps in `ratelimit.ts`; the clock is passed in so tests can jump forward in time.
- Blocks show on the verifier page (count and last five) and go into the audit log as `source.blocked` with a salted hash of the source. No IP address is stored or shown.
- Numbers come from `.env` (`RATE_FAIL_MAX`, `RATE_FAIL_WINDOW_SECONDS`, `RATE_BLOCK_SECONDS`, `RATE_CREATE_MAX_PER_MINUTE`).
- Honest limits: counters live in the front door's memory, so they reset when it restarts. On one laptop every browser has the same IP address, so all local users share a bucket.

## Load test

- The button creates 50 requests as the synthetic verifier `verifier:load-test` and polls each once (100 calls), five at a time, through the front door.
- It shows a bar per instance (from the `X-Served-By` header), average and slowest time, and failures, updating as it runs.
- It has its own limit bucket (1000 per minute), so it is neither blocked by the normal creation limit nor uses it up.
- Synthetic requests are shared between instances (so any instance can answer a poll) but never written to the audit log. At the end they are deleted on every instance and one summary line is logged: "load-test: 50 requests, 0 failures".
- Each instance card shows calls served, failures (errors on our side) and uptime.
- If an instance dies mid-test, the front door retries on another alive instance, so calls still succeed.
- Honest limit: this measures a laptop talking to itself. The numbers show that load is shared and survives a failure; they say nothing about real-world capacity.

### Giving a credential back after revoking
The issuer console has a **Give back** button on revoked students. A reason code must be chosen first (`revoked_in_error`, `re_enrolled`, `device_replaced`, `appeal_accepted`).
- The old credential is **not** un-revoked. Its bit stays 1 for ever, because verifiers merge lists with OR and must never be able to "forget" a revocation.
- The student becomes active again and a new claim code is opened. They collect a **new** credential, which gets a new position in the list. Old positions are kept in `retired_indexes` so they are never reused.
- In the wallet, the new card replaces the old one for that student.
- **Common mistake:** clicking Give back and then presenting the old card. It is still refused as Revoked, because giving back only makes the student eligible again. The student must claim the new credential. The wallet now greys out a revoked card and says so, and the issuer console shows "No credential collected yet" until the new one is claimed.
