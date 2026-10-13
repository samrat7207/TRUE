// Small shared pieces of the Control Room: where the servers are, a "repeat every second" helper, and buttons.
import { useEffect, useRef, type ReactNode } from 'react';

// The Control Room only ever runs on the laptop itself, so the servers are on the same machine as this page.
const HOST = `http://${window.location.hostname}`;
export const FRONT_DOOR = `${HOST}:4000`; // verifier front door (also the operations routes)
export const CORE_API = `${HOST}:4001`; // accounts and issuing

// Fetch JSON, or null if the server is unreachable or refused.
export async function getJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(4000) });
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

// Run "job" now and then every "ms" milliseconds while the component is on screen.
export function useEvery(job: () => void, ms: number, active = true) {
  const latest = useRef(job);
  latest.current = job; // always call the newest version of the function
  useEffect(() => {
    if (!active) return;
    latest.current();
    const timer = setInterval(() => latest.current(), ms);
    return () => clearInterval(timer);
  }, [ms, active]);
}

// Compact pill button for the wide screen (the phone app's PillButton is full width).
export function SmallButton({ children, onClick, kind = 'primary', disabled }: {
  children: ReactNode; onClick?: () => void; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean;
}) {
  const kinds = {
    primary: 'bg-ink text-white',
    secondary: 'bg-surface text-ink border border-line',
    danger: 'bg-bad text-white',
  };
  return (
    <button onClick={onClick} disabled={disabled} className={`rounded-pill px-4 py-2 text-small font-semibold transition disabled:cursor-not-allowed disabled:opacity-30 ${kinds[kind]}`}>
      {children}
    </button>
  );
}

// A section of the main column, with the heading the sidebar links jump to.
export function Section({ id, title, note, right, children }: { id: string; title: string; note?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="mb-8 scroll-mt-5">
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold">{title}</h2>
          {note && <p className="text-small text-muted">{note}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

// "42s", "3m 05s", "1h 02m".
export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`;
}
