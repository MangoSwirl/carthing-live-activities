import { BridgethingClient, type ConnectionState } from '@bridgething/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { daemonUrl } from './daemon';

type View = { svg: string; width: number; height: number; cornerRadius?: number; tint?: number[] | null };
type ViewKey = 'listItem' | 'expanded' | 'compactLeading' | 'compactTrailing' | 'minimal';
type Views = Partial<Record<ViewKey, View>>;

type Activity = {
  id: string;
  bundleId: string;
  appName: string;
  startedAt: number | null;
  updatedAt: number | null;
  staleAt: number | null;
  content: unknown;
  texts: string[];
  rev: string;
  views?: Views;
};

type Problem = { code: string; title: string; detail: string; steps: string[] };
type Snapshot = { type: 'snapshot'; at: number; icons: Record<string, string>; activities: Activity[]; problem?: Problem | null };

// the bridge heartbeats every 5s, so silence past this means the mac side is gone
const STALE_LINK_MS = 12_000;
// ios draws lock-screen activities as glass over the wallpaper. measured on solid black/grey/white/blue wallpapers
// (screenshots converted from display p3 to srgb): a tinted card keeps the stored tint's hue at full brightness and
// its saturation rises as the backdrop darkens, reaching 1 over black; an untinted card over black is #131313.
// our backdrop is black, so those are the values used, for every app.
const UNTINTED_GLASS = '#131313';
const glass = (c: string) => `hsl(from ${c} h 100% 50%)`;
// the knob overhangs the right edge of the 800px panel and hides x >= ~753 through the upper half of the screen,
// so content is laid out in the visible width and the strip under the knob stays empty
const SCREEN_W = 800;
const KNOB_INSET = 47;
const PAD = 24;
const CONTENT_W = SCREEN_W - KNOB_INSET - PAD * 2;

function since(ms: number | null, now: number): string {
  if (!ms) return '';
  const m = Math.max(0, Math.floor((now - ms) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

function rgba(c: number[] | null | undefined, fallback: string): string {
  if (!c || c.length < 4 || c[3] === 0) return fallback;
  const [r, g, b, a] = c.map(v => (v <= 1 ? v : v / 255));
  return `rgba(${Math.round(r! * 255)},${Math.round(g! * 255)},${Math.round(b! * 255)},${a})`;
}

function Icon({ src, name, size }: { src?: string; name: string; size: number }) {
  return src ? (
    <img src={src} alt="" style={{ width: size, height: size }} className="shrink-0 rounded-[22%] object-cover" />
  ) : (
    <div
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      className="grid shrink-0 place-items-center rounded-[22%] bg-neutral-soft font-display font-semibold text-soft">
      {name.slice(0, 1)}
    </div>
  );
}

// a timer the way ios shows it: countdowns round up so they read 10:00 at the start, count-ups round down
function timerText(el: SVGElement, now: number): string {
  const d = el.dataset;
  const start = Number(d.laTimerStart);
  const end = Number(d.laTimerEnd);
  const down = d.laTimerCountdown !== '0';
  const elapsed = Math.min(Math.max(now, start), end) - start;
  const ms = down ? end - start - elapsed : elapsed;
  const total = Math.max(0, down ? Math.ceil(ms / 1000) : Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// archives freeze timers and timeline progress at render time; ios ticks them on display (timers change instantly)
function tick(root: ParentNode, now: number) {
  root.querySelectorAll<SVGTextElement>('text[data-la-timer-end]').forEach(el => {
    const text = timerText(el, now);
    if (el.textContent !== text) el.textContent = text;
  });
  root.querySelectorAll<SVGRectElement>('[data-la-progress-end]').forEach(el => {
    const start = Number(el.dataset.laProgressStart);
    const end = Number(el.dataset.laProgressEnd);
    const full = Number(el.dataset.laProgressWidth);
    const done = end > start ? Math.min(1, Math.max(0, (now - start) / (end - start))) : 1;
    const f = el.dataset.laProgressCountdown === '1' ? 1 - done : done;
    el.setAttribute('width', String(full * f));
  });
}

const ROLL_MS = 420;
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

// replays swiftui's text content transitions between two archive versions. when only digits changed, characters
// shared at the start and end stay put and the changed run rolls vertically with a blur, upward when the value grows
function rollNumeric(prev: Element, next: Element) {
  next.querySelectorAll<SVGGElement>('g[data-la-numeric]').forEach(group => {
    const key = group.dataset.laNumeric!;
    const old = prev.querySelector<SVGGElement>(`g[data-la-numeric="${CSS.escape(key)}"]`);
    const a = old?.dataset.laText ?? '';
    const b = group.dataset.laText ?? '';
    if (!old || a === b) return;
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    // the default text transition rolls digits; other changes cross-fade the text with a blur
    const numeric = (t: string) => /^[0-9.,:]*$/.test(t) && /[0-9]/.test(t);
    if (!numeric(a.slice(pre, a.length - suf)) || !numeric(b.slice(pre, b.length - suf))) {
      const ghost = old.cloneNode(true) as SVGGElement;
      group.after(ghost);
      group.animate({ opacity: [0, 1], filter: ['blur(3px)', 'blur(0)'] }, { duration: ROLL_MS, easing: EASE });
      ghost
        .animate({ opacity: [1, 0], filter: ['blur(0)', 'blur(3px)'] }, { duration: ROLL_MS, easing: EASE, fill: 'forwards' })
        .finished.then(() => ghost.remove());
      return;
    }
    const num = (t: string) => parseFloat(t.replace(/[^0-9.-]/g, ''));
    const grew = num(b) >= num(a);
    const up = group.dataset.laCountsDown === '1' ? !grew : grew;
    const h = group.getBBox().height || 10;
    const dy = (up ? 1 : -1) * h * 0.7;
    const inRange = (i: number, len: number) => i >= pre && i < len - suf;
    group.querySelectorAll<SVGGElement>('g[data-la-ch]').forEach(ch => {
      if (!inRange(Number(ch.dataset.laI), b.length)) return;
      ch.animate(
        { transform: [`translateY(${dy}px)`, 'translateY(0)'], opacity: [0, 1], filter: ['blur(3px)', 'blur(0)'] },
        { duration: ROLL_MS, easing: EASE },
      );
    });
    old.querySelectorAll<SVGGElement>('g[data-la-ch]').forEach(ch => {
      if (!inRange(Number(ch.dataset.laI), a.length)) return;
      const ghost = ch.cloneNode(true) as SVGGElement;
      group.append(ghost);
      ghost
        .animate(
          { transform: ['translateY(0)', `translateY(${-dy}px)`], opacity: [1, 0], filter: ['blur(0)', 'blur(3px)'] },
          { duration: ROLL_MS, easing: EASE, fill: 'forwards' },
        )
        .finished.then(() => ghost.remove());
    });
  });
}

// inline so the ticker can reach the timer and progress elements. a new archive replaces the old render at once,
// as ios does; only text the app marked with a numericText content transition rolls (see rollNumeric). fading whole
// layers is avoided on purpose: an animating layer is isolated, which breaks archived blend modes and flashes colour
function Svg({ svg, className, style }: { svg: string; className?: string; style?: React.CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const previous = el.firstElementChild;
    const layer = document.createElement('div');
    layer.style.cssText = 'position:absolute;inset:0';
    layer.innerHTML = svg;
    const root = layer.querySelector('svg');
    root?.setAttribute('width', '100%');
    root?.setAttribute('height', '100%');
    el.prepend(layer);
    tick(layer, Date.now());
    if (previous) {
      rollNumeric(previous, layer);
      previous.remove();
    }
    const t = setInterval(() => tick(layer, Date.now()), 250);
    return () => clearInterval(t);
  }, [svg]);
  return <div ref={ref} className={className} style={{ position: 'relative', ...style }} />;
}

// the lock-screen presentation the iphone rendered, redrawn from its decoded display list at screen width
function Card({ a, width, maxH }: { a: Activity; width: number; maxH: number }) {
  const view = a.views?.listItem ?? a.views?.expanded;
  if (!view) {
    return (
      <div className="flex flex-col gap-1 rounded-[40px] bg-[#131313] px-10 py-7" style={{ width }}>
        {(a.texts.length ? a.texts : [a.appName]).slice(0, 4).map((t, i) => (
          <div key={i} className={i === 0 ? 'font-display text-screen-title font-medium' : 'text-hero text-soft'}>
            {t}
          </div>
        ))}
      </div>
    );
  }
  const scale = Math.min(width / view.width, maxH / view.height);
  const tinted = !!view.tint && (view.tint[3] ?? 0) > 0;
  return (
    <div
      className="overflow-hidden shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)]"
      style={{
        width: view.width * scale,
        height: view.height * scale,
        borderRadius: (view.cornerRadius ?? 20) * scale,
        background: tinted ? glass(rgba(view.tint, '')) : UNTINTED_GLASS,
      }}>
      <Svg svg={view.svg} className="h-full w-full" />
    </div>
  );
}

type Phase = 'enter' | 'live' | 'exit';
type Row = { a: Activity; phase: Phase };

const ENTER_EXIT_MS = 450;

// keeps departed activities around long enough to animate out, at the position they held
function usePresence(activities: Activity[]): Row[] {
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    setRows(prev => {
      const live = new Set(activities.map(a => a.id));
      const known = new Set(prev.map(r => r.a.id));
      const next: Row[] = activities.map(a => ({
        a,
        phase: known.has(a.id) ? (prev.find(r => r.a.id === a.id)!.phase === 'exit' ? 'enter' : 'live') : 'enter',
      }));
      prev.forEach((r, i) => {
        if (!live.has(r.a.id)) next.splice(Math.min(i, next.length), 0, { a: r.a, phase: 'exit' });
      });
      return next;
    });
  }, [activities]);

  useEffect(() => {
    if (rows.some(r => r.phase === 'enter')) {
      // two frames so the collapsed starting state is painted before the transition begins
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() =>
          setRows(prev => prev.map(r => (r.phase === 'enter' ? { ...r, phase: 'live' } : r))),
        );
      });
      return () => (cancelAnimationFrame(outer), cancelAnimationFrame(inner));
    }
    if (rows.some(r => r.phase === 'exit')) {
      const t = setTimeout(() => setRows(prev => prev.filter(r => r.phase !== 'exit')), ENTER_EXIT_MS);
      return () => clearTimeout(t);
    }
  }, [rows]);

  return rows;
}

export default function App() {
  const client = useMemo(() => new BridgethingClient({ url: daemonUrl() }), []);
  const [conn, setConn] = useState<ConnectionState>(client.connectionState);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [lastSeen, setLastSeen] = useState(0);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [now, setNow] = useState(Date.now());
  const views = useRef(new Map<string, { rev: string; views: Views }>());
  const lastHello = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  const rows = usePresence(activities);

  useEffect(() => {
    const hello = () => {
      lastHello.current = Date.now();
      void client.forward.json({ type: 'hello' });
    };
    const offConn = client.on(event => {
      if (event.type === 'open' || event.type === 'close' || event.type === 'connecting') setConn(client.connectionState);
      if (event.type === 'open') hello();
    });
    const offJson = client.forward.onJson(raw => {
      const msg = raw as Snapshot;
      if (msg?.type !== 'snapshot') return;
      setLastSeen(Date.now());
      setProblem(msg.problem ?? null);
      if (msg.icons) setIcons(prev => ({ ...prev, ...msg.icons }));
      let missing = false;
      const merged = msg.activities.map(a => {
        if (a.views) views.current.set(a.id, { rev: a.rev, views: a.views });
        const cached = views.current.get(a.id);
        if (cached?.rev !== a.rev) missing = true;
        return { ...a, views: cached?.views };
      });
      for (const id of [...views.current.keys()]) if (!merged.some(a => a.id === id)) views.current.delete(id);
      // an activity only appears once its views have arrived, never as a placeholder first
      setActivities(merged.filter(a => views.current.has(a.id)));
      // heartbeats carry no views; ask for a full snapshot when ours are behind, at most every few seconds
      if (missing && Date.now() - lastHello.current > 3000) hello();
    });
    if (client.connectionState === 'open') hello();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      offConn();
      offJson();
      clearInterval(tick);
    };
  }, [client]);

  const rowEls = () => [...(list.current?.querySelectorAll<HTMLElement>('[data-row]:not([data-phase="exit"])') ?? [])];
  const scrollToRow = (i: number) => rowEls()[i]?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // stay pinned to the newest card at the bottom while rows grow and shrink, unless the user scrolled up to read
  const pinned = useRef(true);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = list.current;
    const inner = content.current;
    if (!el || !inner) return;
    // scroll events land a frame after we set the position, by which time a growing row has made the content taller,
    // so only the user's own input may unpin; any scroll that ends at the bottom pins again
    let userAt = 0;
    const touched = () => (userAt = performance.now());
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      if (atBottom) pinned.current = true;
      else if (performance.now() - userAt < 1000) pinned.current = false;
    };
    const ro = new ResizeObserver(() => pinned.current && (el.scrollTop = el.scrollHeight));
    const inputs = ['pointerdown', 'touchstart', 'wheel', 'keydown'] as const;
    inputs.forEach(t => window.addEventListener(t, touched, { passive: true, capture: true }));
    el.addEventListener('scroll', onScroll, { passive: true });
    ro.observe(inner);
    return () => {
      inputs.forEach(t => window.removeEventListener(t, touched, { capture: true }));
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, []);

  // a new activity always comes into view
  const seen = useRef(new Set<string>());
  useEffect(() => {
    if (activities.some(a => !seen.current.has(a.id))) pinned.current = true;
    activities.forEach(a => seen.current.add(a.id));
  }, [activities]);

  useEffect(() => {
    let acc = 0;
    // the knob steps card to card from whichever card is nearest the middle of the screen
    const step = (d: number) => {
      const els = rowEls();
      const box = list.current?.getBoundingClientRect();
      if (!els.length || !box) return;
      const mid = box.top + box.height / 2;
      const dist = els.map(el => {
        const r = el.getBoundingClientRect();
        return Math.abs(r.top + r.height / 2 - mid);
      });
      const cur = dist.indexOf(Math.min(...dist));
      scrollToRow(Math.min(els.length - 1, Math.max(0, cur + d)));
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.deltaX) return;
      acc += e.deltaX;
      if (Math.abs(acc) >= 40) {
        step(acc > 0 ? 1 : -1);
        acc = 0;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      const n = Number(e.key);
      if (n >= 1 && n <= 4) scrollToRow(n - 1);
    };
    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const linked = conn === 'open' && now - lastSeen < STALE_LINK_MS;
  const empty = rows.length === 0;

  return (
    <div className="relative h-full w-full bg-black font-body text-off-white">
      <span
        className={`absolute right-3 bottom-3 z-10 h-2 w-2 rounded-full transition-colors ${linked ? 'bg-ok/70' : 'bg-err'}`}
      />
      <div ref={list} className="la-scroll h-full w-full overflow-y-auto overscroll-contain">
        <div ref={content} className="flex min-h-full flex-col justify-end py-4">
          {rows.map(({ a, phase }) => {
            const stale = !!a.staleAt && a.staleAt < now;
            return (
              <div key={a.id} data-row data-phase={phase} className="la-row">
                <div className="la-row-inner">
                  <div
                    style={{ paddingLeft: PAD, paddingRight: PAD + KNOB_INSET }}
                    className={`flex flex-col gap-2.5 py-3 transition-opacity duration-500 ${stale ? 'opacity-50' : ''}`}
>
                    <div className="flex items-center gap-2.5 px-1">
                      <Icon src={icons[a.bundleId]} name={a.appName} size={26} />
                      <span className="font-display text-title font-medium tracking-display">{a.appName}</span>
                      <span className="ml-auto font-mono text-hint text-dim">
                        {stale ? 'stale · ' : ''}
                        {since(a.updatedAt ?? a.startedAt, now)}
                      </span>
                    </div>
                    <Card a={a} width={CONTENT_W} maxH={380} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div
        style={{ paddingRight: KNOB_INSET }}
        className={`pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 transition-opacity duration-500 ${empty ? 'opacity-100' : 'opacity-0'}`}>
        {linked && problem ? (
          <div className="flex max-w-[600px] flex-col gap-4 px-8">
            <div className="font-display text-screen-title leading-tight font-medium">{problem.title}</div>
            <div className="text-row text-soft">{problem.detail}</div>
            <ol className="flex flex-col gap-2">
              {problem.steps.map((step, i) => (
                <li key={i} className="flex gap-3 text-row text-near">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-neutral-soft font-mono text-hint">
                    {i + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <>
            <div className="font-display text-screen-title font-medium text-soft">No Live Activities</div>
            <div className="max-w-[560px] text-center font-mono text-hint leading-relaxed text-dim">
              {conn !== 'open'
                ? conn
                : linked
                  ? 'they show up here as soon as your iPhone starts one'
                  : 'needs the bridgething desktop app on a Mac running macOS 26, with full disk access and this app installed there'}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
