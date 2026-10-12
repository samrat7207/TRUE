// The ONLY place in this project that touches cryptography.
// We do not implement any crypto ourselves. Everything here is a thin wrapper over:
//   - @sd-jwt/sd-jwt-vc : SD-JWT VC issue / present / verify (selective disclosure + key binding)
//   - @owf/crypto       : ES256 sign/verify helpers, SHA-256, salt generation
//   - jose              : the small signed "I own this key" proof used at issuance
//   - WebCrypto         : built into browsers and Node; makes the holder key and random values
// The same file runs in the browser (wallet) and in Node (issuer, verifier, tests).
import { SDJwtVcInstance } from '@sd-jwt/sd-jwt-vc';
import { ES256, digest, generateSalt, sha256 } from '@owf/crypto';
import { SignJWT, jwtVerify, importJWK, EmbeddedJWK, decodeJwt, decodeProtectedHeader } from 'jose';

// A JSON Web Key: a key written as a small JSON object.
export type Jwk = Record<string, unknown>;

// Settings every SD-JWT instance needs: how to hash and how to make salts.
const COMMON = { hasher: digest, hashAlg: 'sha-256' as const, saltGenerator: generateSalt };

// How old a presentation may be before the verifier refuses it.
export const PRESENTATION_MAX_AGE_SECONDS = 300;

const nowSeconds = () => Math.floor(Date.now() / 1000);

// ---------- random values ----------

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

// Long unguessable value for nonces and request ids (128 bits, written as hex).
export function randomToken(): string {
  return Array.from(randomBytes(16), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Short code a person can type. 8 characters from a 32-letter alphabet (no 0/O/1/I) = 40 bits.
// That is enough only because a code lives for minutes and works once.
export function randomClaimCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(8), (b) => alphabet[b % 32]).join('');
}

// SHA-256 fingerprint of a text, as hex. Used to compare the revocation list with its anchor on the chain.
export function sha256Hex(text: string): string {
  return Array.from(sha256(text), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- keys ----------

// Issuer signing key pair (ES256 = ECDSA on the P-256 curve with SHA-256).
export async function generateSigningKeyPair(): Promise<{ publicJwk: Jwk; privateJwk: Jwk }> {
  const pair = await ES256.generateKeyPair();
  return { publicJwk: pair.publicKey as Jwk, privateJwk: pair.privateKey as Jwk };
}

// Holder key pair, made on the user's device.
// extractable = false: the browser will sign with the private key but never reveal it, even to our own code.
export async function generateHolderKey(): Promise<{ privateKey: CryptoKey; publicJwk: Jwk }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  // Keep only the public curve point; drop browser-specific extras.
  return { privateKey: pair.privateKey, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
}

// ---------- issuance: proof that the wallet owns its key ----------

// Wallet side: sign the issuer's nonce with the holder key and attach the public key.
export async function createHolderProof(input: {
  holderPrivateKey: CryptoKey;
  holderPublicJwk: Jwk;
  nonce: string;
  audience: string; // the issuer id
}): Promise<string> {
  return new SignJWT({ nonce: input.nonce })
    .setProtectedHeader({ alg: 'ES256', typ: 'holder-proof+jwt', jwk: input.holderPublicJwk })
    .setAudience(input.audience)
    .setIssuedAt()
    .sign(input.holderPrivateKey);
}

// Issuer side: check the proof. Returns the holder's public key, or null if the proof is bad.
export async function verifyHolderProof(
  proofJwt: string,
  expected: { nonce: string; audience: string },
): Promise<Jwk | null> {
  try {
    // EmbeddedJWK = "verify with the public key found in the token's own header".
    const { payload, protectedHeader } = await jwtVerify(proofJwt, EmbeddedJWK, {
      audience: expected.audience,
      algorithms: ['ES256'],
      maxTokenAge: '5 minutes',
    });
    if (payload.nonce !== expected.nonce) return null;
    return protectedHeader.jwk as Jwk;
  } catch {
    return null;
  }
}

// ---------- issuance: sign the credential ----------

export async function issueCredential(input: {
  issuerId: string;
  issuerPrivateJwk: Jwk;
  keyId: string; // which issuer key signed this (the verifier looks it up in the registry)
  holderPublicJwk: Jwk;
  statusIndex: number; // this credential's position in the issuer's revocation list
  statusListUrl: string;
  type: string;
  claims: Record<string, unknown>;
  validDays: number;
}): Promise<string> {
  const sdjwt = new SDJwtVcInstance({
    ...COMMON,
    signer: await ES256.getSigner(input.issuerPrivateJwk),
    signAlg: 'ES256',
  });
  const now = nowSeconds();
  return sdjwt.issue(
    {
      iss: input.issuerId,
      iat: now,
      exp: now + input.validDays * 24 * 60 * 60,
      vct: input.type,
      cnf: { jwk: input.holderPublicJwk }, // binds the credential to the holder's key
      // Always visible to the verifier: where to find the revocation bit for this credential.
      // It is a position number in a public list, not personal data.
      revocation: { idx: input.statusIndex, uri: input.statusListUrl },
      ...input.claims,
    },
    // Every claim becomes its own salted hash, so each one can be revealed or hidden separately.
    { _sd: Object.keys(input.claims) } as never,
    { header: { kid: input.keyId } },
  );
}

// ---------- wallet: read and present ----------

// All claims inside a credential the wallet holds (used to draw the card). No signature check here:
// the wallet received it straight from the issuer.
export async function readCredential(credential: string): Promise<Record<string, unknown>> {
  return new SDJwtVcInstance(COMMON).getClaims(credential);
}

// Build a presentation that reveals only `claims`, signed by the holder key for one verifier and one nonce.
export async function createPresentation(input: {
  credential: string;
  holderPrivateKey: CryptoKey;
  claims: string[];
  nonce: string;
  audience: string; // the verifier id
}): Promise<string> {
  const sdjwt = new SDJwtVcInstance({
    ...COMMON,
    kbSigner: async (data: string) => {
      const signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        input.holderPrivateKey,
        new TextEncoder().encode(data),
      );
      return toBase64Url(new Uint8Array(signature));
    },
    kbSignAlg: 'ES256',
  });
  const frame = Object.fromEntries(input.claims.map((name) => [name, true]));
  return sdjwt.present(input.credential, frame, {
    kb: { payload: { iat: nowSeconds(), aud: input.audience, nonce: input.nonce } },
  });
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------- verifier: check a presentation ----------

// What the registry says about an issuer key.
export type IssuerKeyInfo = { publicJwk: Jwk; state: string }; // state: Active | Retired | Compromised

export type VerifyResult =
  | { ok: true; issuer: string; statusIndex: number | null; claims: Record<string, unknown> }
  | { ok: false; code: string; message: string };

// Checks, in the library: issuer signature, disclosures match the signed hashes, credential expiry,
// holder key-binding signature, nonce, audience, and freshness.
export async function verifyPresentation(input: {
  presentation: string;
  nonce: string;
  audience: string;
  // Looks up an issuer key in the registry. Returns null for unknown issuers or key ids.
  getIssuerKey: (issuerId: string, keyId: string) => Promise<IssuerKeyInfo | null> | IssuerKeyInfo | null;
}): Promise<VerifyResult> {
  // Step 1: read (without trusting) who claims to have issued this, so we know which key to check against.
  let issuer: string;
  let keyId: string;
  try {
    const issuerJwt = input.presentation.split('~')[0];
    issuer = String(decodeJwt(issuerJwt).iss);
    keyId = String(decodeProtectedHeader(issuerJwt).kid);
  } catch {
    return { ok: false, code: 'malformed', message: 'Not a readable SD-JWT' };
  }
  const issuerKey = await input.getIssuerKey(issuer, keyId);
  if (!issuerKey) return { ok: false, code: 'unknown_issuer', message: `Issuer ${issuer} key ${keyId} is not in the registry` };
  // A leaked key can sign anything, so nothing it signed can be trusted any more.
  if (issuerKey.state === 'Compromised') {
    return { ok: false, code: 'issuer_key_compromised', message: 'This credential was signed by a key the issuer has marked as compromised' };
  }
  const issuerJwk = issuerKey.publicJwk;

  // Step 2: full cryptographic verification.
  const sdjwt = new SDJwtVcInstance({
    ...COMMON,
    verifier: await ES256.getVerifier(issuerJwk),
    // The holder's public key is inside the signed credential (cnf.jwk); the proof must verify against it.
    kbVerifier: async (data, signature, payload) => {
      const verify = await ES256.getVerifier(payload.cnf!.jwk as Jwk);
      return verify(data, signature);
    },
  });
  try {
    const result = await sdjwt.verify(input.presentation, {
      // Passing a nonce makes the holder key-binding proof mandatory.
      keyBindingNonce: input.nonce,
      expectedKeyBindingAudience: input.audience,
      keyBindingMaxAgeSeconds: PRESENTATION_MAX_AGE_SECONDS,
      allowedIssuerAlgorithms: ['ES256'],
      allowedKeyBindingAlgorithms: ['ES256'],
    });
    // Return only the disclosed claims, without the technical fields.
    const { iss, iat, exp, vct, cnf, revocation, ...claims } = result.payload as Record<string, unknown>;
    const statusIndex = (revocation as { idx?: number } | undefined)?.idx ?? null;
    return { ok: true, issuer, statusIndex, claims };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, code: errorCode(message), message };
  }
}

// Turn the library's error text into a short stable code for the API and the UI.
function errorCode(message: string): string {
  if (message.includes('Nonce')) return 'nonce_mismatch';
  if (message.includes('audience')) return 'wrong_audience';
  if (message.includes('Key Binding JWT not exist')) return 'missing_holder_binding';
  if (message.includes('too old')) return 'presentation_too_old';
  if (message.includes('Signature')) return 'bad_signature';
  if (message.includes('disclosure')) return 'tampered_disclosure';
  return 'invalid_presentation';
}

// Helper for demos and tests: the list of claim names actually revealed inside a presentation.
// Each disclosure is base64url JSON: [salt, claimName, value].
export function disclosedClaimNames(presentation: string): string[] {
  const parts = presentation.split('~').slice(1, -1); // drop the issuer JWT (first) and the key-binding JWT (last)
  return parts.map((part) => JSON.parse(new TextDecoder().decode(fromBase64Url(part)))[1]);
}

function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

// ---------- verifier authentication: signed requests ----------

// What a verifier asks for. Signed by the verifier so the wallet can tell who is really asking.
export type PresentationRequest = {
  requestId: string;
  verifierId: string;
  purpose: string;
  claims: string[];
  nonce: string;
  responseUri: string;
};

// What the registry says about a verifier.
export type VerifierInfo = { name: string; allowedClaims: string[]; publicJwk: Jwk };

// Verifier side: sign the request with the verifier's private key. "iss" names the verifier.
export async function signRequest(request: PresentationRequest, privateJwk: Jwk, expiresAt: Date): Promise<string> {
  return new SignJWT({ ...request })
    .setProtectedHeader({ alg: 'ES256', typ: 'presentation-request+jwt' })
    .setIssuer(request.verifierId)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(await importJWK(privateJwk, 'ES256'));
}

export type RequestCheck =
  // Signature matches the key registered for this verifier. extraClaims = asked for beyond its registration.
  | { status: 'verified'; request: PresentationRequest; verifierName: string; extraClaims: string[] }
  // Nobody registered this verifier id. claimedBy is what the request says about itself: do not trust it.
  | { status: 'unregistered'; claimedBy: string }
  // The id is registered but the signature does not match its key: forged or changed on the way.
  | { status: 'tampered'; claimedBy: string };

// Wallet side: decide whether a request really comes from a registered verifier.
// The name shown to the user comes from the registry, never from the request itself.
export async function authenticateRequest(
  signedRequest: string,
  getVerifier: (verifierId: string) => Promise<VerifierInfo | null> | VerifierInfo | null,
): Promise<RequestCheck> {
  let claimedBy: string;
  try {
    claimedBy = String(decodeJwt(signedRequest).iss); // read without trusting, to know which key to check
  } catch {
    return { status: 'tampered', claimedBy: 'unreadable request' };
  }
  const verifier = await getVerifier(claimedBy);
  if (!verifier) return { status: 'unregistered', claimedBy };
  try {
    const { payload } = await jwtVerify(signedRequest, await importJWK(verifier.publicJwk, 'ES256'), { algorithms: ['ES256'], issuer: claimedBy });
    const request = payload as unknown as PresentationRequest;
    if (request.verifierId !== claimedBy) return { status: 'tampered', claimedBy };
    const extraClaims = request.claims.filter((claim) => !verifier.allowedClaims.includes(claim));
    return { status: 'verified', request, verifierName: verifier.name, extraClaims };
  } catch {
    return { status: 'tampered', claimedBy };
  }
}
