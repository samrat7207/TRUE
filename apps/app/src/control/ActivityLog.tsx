// Activity section: one live log made from two feeds, the core API's and the verifier front door's.
// Each feed is asked once a second for the events after the last one we have ("after=<seq>"),
// and the two are merged by time. The servers never put personal data in these events.
import { useEffect, useRef, useState } from 'react';
import type { EventLevel, EventPage, LiveEvent } from '@true/shared';
import { CORE_API, FRONT_DOOR, Section, getJson, useEvery } from './parts.tsx';

type Row = LiveEvent & { key: string };
type Filter = 'all' | EventLevel;

const FEEDS = [{ name: 'Core API (4001)', url: `${CORE_API}/ops/events` }, { name: 'Front door (4000)', url: `${FRONT_DOOR}/ops/events` }];
const KEEP = 2000; // rows kept in the browser
const FILTERS: Record<Filter, string> = { all: 'All', info: 'Info', success: 'Success', warn: 'Warning', error: 'Failure' };
// Row colours on the dark console.
const ROW_COLOUR: Record<EventLevel, string> = { info: 'text-white', success: 'text-emerald-400', warn: 'text-yellow-300', error: 'text-red-400' };
const SOURCE_NAMES: Record<string, string> = { issuer: 'Issuer', 'front-door': 'Front door', system: 'System', 'verifier-1': 'Server 1', 'verifier-2': 'Server 2', 'verifier-3': 'Server 3' };

const clock = (ts: string) => new Date(ts).toLocaleTimeString('en-GB'); // HH:MM:SS

export function ActivityLog() {
  const [rows, setRows] = useState<Row[]>([]);
  const [down, setDown] = useState<string[]>([]); // names of feeds that did not answer
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [paused, setPaused] = useState(false);
  const [clearedAt, setClearedAt] = useState(''); // "Clear" only hides older rows in this view

  // Where we are in each feed. "boot" changes when that server restarts; then we read its list from the start.
  const cursors = useRef(FEEDS.map(() => ({ boot: '', seq: 0, busy: false })));
  const seen = useRef(new Set<string>());
  const phones = useRef(new Map<string, number>()); // device hash => 1, 2, ... in the order first seen

  async function poll() {
    const fresh: Row[] = [];
    const unreachable: string[] = [];
    await Promise.all(FEEDS.map(async (feed, index) => {
      const cursor = cursors.current[index];
      if (cursor.busy) return;
      cursor.busy = true;
      const page = await getJson<EventPage>(`${feed.url}?after=${cursor.seq}&limit=500`);
      cursor.busy = false;
      if (!page) { unreachable.push(feed.name); return; }
      if (page.boot !== cursor.boot && cursor.seq > 0) { cursor.boot = page.boot; cursor.seq = 0; return; } // restarted: start again next time
      cursor.boot = page.boot;
      for (const event of page.events) {
        cursor.seq = Math.max(cursor.seq, event.seq);
        const key = `${index}|${page.boot}|${event.seq}`;
        if (seen.current.has(key)) continue;
        seen.current.add(key);
        fresh.push({ ...event, key });
      }
    }));
    setDown(unreachable);
    if (fresh.length > 0) setRows((old) => [...old, ...fresh].sort((a, b) => a.ts.localeCompare(b.ts)).slice(-KEEP));
  }
  useEvery(poll, 1000, !paused);

  // The chip in front of each line: the device if a phone caused it, otherwise the server that wrote it.
  function chip(row: Row): { label: string; classes: string } {
    if (row.device) {
      const [hash, kind] = row.device.split(':');
      if (kind === 'laptop') return { label: 'Laptop phone', classes: 'bg-violet-500/25 text-violet-200' };
      if (!phones.current.has(hash)) phones.current.set(hash, phones.current.size + 1);
      return { label: `Phone ${phones.current.get(hash)}`, classes: 'bg-sky-500/25 text-sky-200' };
    }
    return { label: SOURCE_NAMES[row.source] ?? row.source, classes: 'bg-white/10 text-white/70' };
  }

  const current = rows.filter((row) => row.ts > clearedAt).map((row) => ({ ...row, chip: chip(row) })); // in time order, so Phone 1 is the first seen
  const counts = (level: Filter) => (level === 'all' ? current.length : current.filter((row) => row.level === level).length);
  const words = search.trim().toLowerCase();
  const visible = current.filter((row) => (filter === 'all' || row.level === filter) && (!words || `${row.chip.label} ${row.message} ${row.code}`.toLowerCase().includes(words)));
  const line = (row: (typeof visible)[number]) => `${clock(row.ts)}  [${row.chip.label}]  ${row.level.toUpperCase().padEnd(7)}  ${row.message}`;

  // Keep the newest line in view.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!paused && box.current) box.current.scrollTop = box.current.scrollHeight; }, [visible.length, paused]);

  // Download exactly what is visible as a text file.
  function exportLog() {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new window.Blob([visible.map(line).join('\n') + '\n'], { type: 'text/plain' }));
    link.download = `true-activity-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  const control = 'rounded-pill border border-white/15 px-3 py-1 text-tiny font-semibold text-white/80 hover:bg-white/10 disabled:opacity-30';
  return (
    <Section id="activity" title="Activity" note="Live events from every server. No names, emails or shared values are ever written here.">
      <div className="overflow-hidden rounded-card bg-ink text-white">
        <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-3">
          {(Object.keys(FILTERS) as Filter[]).map((key) => (
            <button key={key} onClick={() => setFilter(key)} className={`rounded-pill px-3 py-1 text-tiny font-semibold ${filter === key ? 'bg-white text-ink' : 'bg-white/10 text-white/80'}`}>
              {FILTERS[key]} <span className="font-mono opacity-70">{counts(key)}</span>
            </button>
          ))}
          <input
            value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter text…" aria-label="Filter the log by text"
            className="ml-auto w-40 rounded-pill border border-white/15 bg-transparent px-3 py-1 text-tiny text-white placeholder:text-white/40"
          />
          <button className={control} onClick={() => setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</button>
          <button className={control} onClick={() => setClearedAt(new Date().toISOString())}>Clear</button>
          <button className={control} disabled={visible.length === 0} onClick={exportLog}>Export</button>
        </div>
        {down.length > 0 && <div className="bg-red-500/20 px-4 py-1.5 text-tiny text-red-200">Feed disconnected: {down.join(', ')}. Retrying every second.</div>}
        {paused && <div className="bg-yellow-500/15 px-4 py-1.5 text-tiny text-yellow-200">Paused. New events appear when you resume.</div>}
        <div ref={box} className="h-80 overflow-y-auto px-4 py-3 font-mono text-[12px] leading-6">
          {visible.length === 0 && <div className="text-white/40">{current.length === 0 ? 'Waiting for events… log in or scan on a phone.' : 'No line matches this filter.'}</div>}
          {visible.map((row) => (
            <div key={row.key} className={`flex gap-3 ${ROW_COLOUR[row.level]}`}>
              <span className="shrink-0 text-white/40">{clock(row.ts)}</span>
              <span className={`h-5 shrink-0 self-center rounded-pill px-2 text-[10px] font-semibold leading-5 ${row.chip.classes}`}>{row.chip.label}</span>
              <span className="min-w-0 break-words">{row.message}</span>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}
