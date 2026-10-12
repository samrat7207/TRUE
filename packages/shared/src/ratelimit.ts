// Two small in-memory limiters, used by the verifier front door and by the issuer's PIN sign-in. No library: each is a Map and some arithmetic.
// "now" is passed in so tests can move the clock instead of waiting.

type Clock = () => number; // milliseconds

// Blocks a source after too many FAILED attempts.
// Example: 5 failures inside 60 seconds => blocked for 60 seconds.
export function createFailureLimiter(config: { max: number; windowSeconds: number; blockSeconds: number; now: Clock }) {
  const failures = new Map<string, number[]>(); // source => times of its recent failures
  const blockedUntil = new Map<string, number>(); // source => time the block ends

  return {
    // Seconds this source must still wait. 0 means it is not blocked.
    retryAfter(source: string): number {
      const until = blockedUntil.get(source) ?? 0;
      if (until <= config.now()) {
        blockedUntil.delete(source); // the block has expired
        return 0;
      }
      return Math.ceil((until - config.now()) / 1000);
    },

    // Remember one failure. Returns true if this failure is the one that starts a block.
    recordFailure(source: string): boolean {
      const windowStart = config.now() - config.windowSeconds * 1000;
      const recent = (failures.get(source) ?? []).filter((time) => time > windowStart);
      recent.push(config.now());
      if (recent.length >= config.max) {
        failures.delete(source); // start counting afresh after the block
        blockedUntil.set(source, config.now() + config.blockSeconds * 1000);
        return true;
      }
      failures.set(source, recent);
      return false;
    },

    // How many sources are blocked right now.
    blockedCount(): number {
      let count = 0;
      for (const until of blockedUntil.values()) if (until > config.now()) count += 1;
      return count;
    },
  };
}

// Allows at most "max" events per source per window (a plain rate limit, for request creation).
export function createRateCounter(config: { max: number; windowSeconds: number; now: Clock }) {
  const events = new Map<string, number[]>();
  return {
    // Counts this event. Returns 0 if allowed, or the seconds to wait if the source is over its limit.
    hit(source: string): number {
      const windowStart = config.now() - config.windowSeconds * 1000;
      const recent = (events.get(source) ?? []).filter((time) => time > windowStart);
      if (recent.length >= config.max) {
        events.set(source, recent);
        return Math.max(1, Math.ceil((recent[0] + config.windowSeconds * 1000 - config.now()) / 1000));
      }
      recent.push(config.now());
      events.set(source, recent);
      return 0;
    },
  };
}
