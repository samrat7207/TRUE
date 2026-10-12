// Turns the outcome of a verification into a list of named steps for the wallet to show.
// Each step is only a name and pass / fail / skipped. No claim values, no personal data.

export type Step = { name: string; status: 'pass' | 'fail' | 'skipped' };

// The checks, in the order they run.
export const STEP_NAMES = [
  'proof_integrity', // the presentation is well-formed and every disclosure matches a signed hash
  'issuer_key_state', // the signing key is in the registry and not marked Compromised
  'issuer_signature', // the issuer's signature is valid for that key
  'holder_and_audience', // signed by the holder's key, and made for THIS verifier
  'freshness', // answers this request's one-time nonce and is recent
  'revocation_status', // the issuer has not revoked it (our cached list)
  'required_claims', // every requested claim is present and satisfied
] as const;

// Which step a reason code belongs to.
const FAILED_STEP: Record<string, (typeof STEP_NAMES)[number]> = {
  malformed: 'proof_integrity',
  tampered_disclosure: 'proof_integrity',
  invalid_presentation: 'proof_integrity',
  unknown_issuer: 'issuer_key_state',
  issuer_key_compromised: 'issuer_key_state',
  bad_signature: 'issuer_signature',
  missing_holder_binding: 'holder_and_audience',
  wrong_audience: 'holder_and_audience',
  nonce_mismatch: 'freshness',
  presentation_too_old: 'freshness',
  missing_status: 'revocation_status',
  revoked: 'revocation_status',
  missing_claims: 'required_claims',
  requirement_not_met: 'required_claims',
};

// null = everything passed. Otherwise: steps before the failing one passed, the failing one failed,
// and later ones were not reached, so they are reported as skipped rather than guessed.
export function buildSteps(failureCode: string | null): Step[] {
  if (failureCode === null) return STEP_NAMES.map((name) => ({ name, status: 'pass' }));
  const failed = FAILED_STEP[failureCode] ?? 'proof_integrity';
  const failedAt = STEP_NAMES.indexOf(failed);
  return STEP_NAMES.map((name, i) => {
    if (i === failedAt) return { name, status: 'fail' };
    // The library checks holder binding, audience and freshness together and reports only the first problem,
    // so when freshness fails we cannot honestly claim the holder/audience check passed.
    if (failed === 'freshness' && name === 'holder_and_audience') return { name, status: 'skipped' };
    return { name, status: i < failedAt ? 'pass' : 'skipped' };
  });
}
