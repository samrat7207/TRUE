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
