// Live event feed for the Control Room: a small in-memory list of "what just happened" lines.
// RULE: no personal data in any event. Never a person's name, an email, a field value or an IP address.
// Allowed: institution names, verifier and register names, credential types, short opaque ids, reason codes.
import { isLoopback } from './index.ts';

export type EventLevel = 'info' | 'success' | 'warn' | 'error';
export type LiveEvent = {
  seq: number; // counts up from 1 inside one running service
  ts: string; // ISO time
  level: EventLevel;
  source: string; // issuer, front-door, verifier-1, verifier-2, verifier-3 or system
  device: string | null; // "<3 hex>:<class>" (see deviceLabel), or null when no client device is involved
  message: string;
  code: string; // short machine-readable name of the event, e.g. "login_failed"
};
export type EventPage = { boot: string; latest: number; events: LiveEvent[] };

const KEEP = 1000; // a ring buffer: the oldest line is dropped when this many are stored

export function createEventLog(source: string) {
  const events: LiveEvent[] = [];
  let seq = 0;
  // Changes every time the service starts, so a reader knows its "after" position is from an older run.
  const boot = `${source}-${Date.now()}`;

  function store(event: Omit<LiveEvent, 'seq'>) {
    seq += 1;
    events.push({ ...event, seq });
    if (events.length > KEEP) events.shift();
  }

  return {
    emit(level: EventLevel, code: string, message: string, device: string | null = null, from = source) {
      store({ ts: new Date().toISOString(), level, source: from, device, message, code });
    },
    // Copy in an event read from another service's log (the front door collects its instances' events).
    add(event: LiveEvent) {
      store(event);
    },
    // Events newer than "after", oldest first.
    page(after: number, limit = 200): EventPage {
      return { boot, latest: seq, events: events.filter((event) => event.seq > after).slice(0, limit) };
    },
  };
}
export type EventLog = ReturnType<typeof createEventLog>;

// "?after=12&limit=50" => numbers, with safe defaults.
export function eventQuery(query: (name: string) => string | undefined) {
  const after = Number(query('after') ?? 0);
  const limit = Number(query('limit') ?? 200);
  return { after: Number.isFinite(after) ? after : 0, limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 1000) : 200 };
}

// A short label for the calling device: 3 hex characters of a salted hash of its address, plus a coarse
// class read from the User-Agent. The address and the User-Agent themselves are never stored.
// "hash" is supplied by the service (the hashing code lives in packages/credentials).
export function deviceLabel(address: string, userAgent: string, hash: (text: string) => string): string {
  const kind = /Android/i.test(userAgent) ? (/; wv\)/.test(userAgent) ? 'android-app' : 'android-browser') : 'laptop';
  // Every way of writing "this machine" counts as one device; "::ffff:1.2.3.4" is the same device as "1.2.3.4".
  const where = isLoopback(address) ? 'this-machine' : address.replace(/^::ffff:/, '');
  return `${hash(where).slice(0, 3)}:${kind}`;
}

// ---------- operations routes: the laptop only ----------

// The only web pages allowed to call /ops and /proxy routes: the app opened on the laptop itself.
export const OPS_ORIGINS = ['http://localhost:5176', 'http://127.0.0.1:5176'];

// Why this caller may NOT use an operations route, or null if it may.
// It must connect from this machine, must not have come through a forwarder, and if a web page sent it,
// that page must be the app on the laptop (so not a LAN page and not the Android app).
export function opsRefusal(caller: { address: string | null; forwardedFor?: string; origin?: string }): string | null {
  if (caller.address !== null && !isLoopback(caller.address)) return 'not from the server machine';
  if (caller.forwardedFor) return 'forwarded request';
  if (caller.origin && !OPS_ORIGINS.includes(caller.origin)) return 'page not allowed';
  return null;
}
