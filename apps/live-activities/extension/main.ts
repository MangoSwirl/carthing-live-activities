// mirrors the live activities a paired iphone shows on this mac onto the car thing. activity data comes from
// liveactivitiesd's store and the swiftui archives chronod keeps (see source.ts); each archive is decoded into svg
// and forwarded to the webapp. reading those stores needs full disk access for the bridgething desktop app.

import { asJson, defineExtension, json, type Device, type ExtensionContext } from '@bridgething/extension';

import { readArchive, renderView } from './archive/decode';
import { makeGapLog } from './gaps';
import { diagnose, problemFromError, type Problem } from './diagnose';
import { readActivities, watchActivities, type MirroredActivity } from './source';
import { bringForward, restore } from './switcher';

const VIEW_TAGS = {
  listItem: 'listItem',
  expanded: 'dynamicIsland-expanded',
  compactLeading: 'dynamicIsland-compactLeading',
  compactTrailing: 'dynamicIsland-compactTrailing',
  minimal: 'dynamicIsland-compactMinimal',
} as const;
type ViewKey = keyof typeof VIEW_TAGS;
type View = { svg: string; width: number; height: number; cornerRadius?: number; tint?: number[] | null };
type Rendered = { rev: string; views: Partial<Record<ViewKey, View>>; texts: string[] };

// liveactivitiesd's row lands a second or two before chronod's archive; wait this long before falling back to text
const ARCHIVE_GRACE_MS = 8000;
const HEARTBEAT_MS = 5000;
const RECHECK_MS = 10_000;

const revOf = (a: MirroredActivity) => `${a.archivePath}:${a.archiveMtime}:${a.updatedAt}`;

type Gap = ReturnType<typeof makeGapLog>;
type GapReport = { warnings?: string[]; unknowns?: { code: string; detail?: string }[] };

async function render(a: MirroredActivity, gap?: Gap): Promise<Rendered> {
  const out: Rendered = { rev: revOf(a), views: {}, texts: [] };
  if (!a.archivePath) return out;
  const { readFile } = await import('node:fs/promises');
  const archive = readArchive(new Uint8Array(await readFile(a.archivePath)));
  for (const [key, viewTag] of Object.entries(VIEW_TAGS) as [ViewKey, string][]) {
    const v = renderView(archive, { viewTag, colorScheme: 'dark', luminanceReduced: false, redaction: 0 });
    if (!v) continue;
    gap?.(
      { warnings: v.warnings, unknowns: [...((archive as unknown as GapReport).unknowns ?? []), ...((v as unknown as GapReport).unknowns ?? [])] },
      a.archivePath,
      `${a.appName} ${key}`,
    );
    out.views[key] = { svg: v.svg, width: v.width, height: v.height, cornerRadius: v.cornerRadius, tint: v.backgroundTint ?? null };
    if (key === 'listItem' || !out.texts.length) out.texts = v.texts;
  }
  return out;
}

// the iphone app's icon is not on the mac, so use its app store artwork, looked up by bundle id
const icons = new Map<string, string | null>();
async function iconFor(bundleId: string): Promise<void> {
  if (icons.has(bundleId)) return;
  icons.set(bundleId, null);
  try {
    const r = await fetch(`https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(bundleId)}`);
    const art: string | undefined = (await r.json()).results?.[0]?.artworkUrl512;
    if (!art) return;
    const img = await fetch(art.replace(/\/\d+x\d+bb\./, '/192x192bb.'));
    const bytes = new Uint8Array(await img.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    icons.set(bundleId, `data:${img.headers.get('content-type') ?? 'image/jpeg'};base64,${btoa(bin)}`);
  } catch {}
}

function start(ctx: ExtensionContext) {
  // only activities that are ready to draw
  let shown: MirroredActivity[] = [];
  const rendered = new Map<string, Rendered>();
  const firstSeen = new Map<string, number>();
  let tookOver = false;
  let problem: Problem | null = null;
  const gap = makeGapLog(ctx.dataDir, msg => ctx.log.warn(msg));

  const setProblem = (next: Problem | null) => {
    if (next?.code === problem?.code) return;
    problem = next;
    if (next) ctx.log.error(`${next.title}. ${next.detail} ${next.steps.join('; ')}.`);
    else ctx.log.info('live activity stores are readable');
    ctx.broadcast(snapshot('all'));
  };

  const ready = (a: MirroredActivity) => {
    const v = rendered.get(a.id)?.views;
    return !!(v?.listItem || v?.expanded) || Date.now() - (firstSeen.get(a.id) ?? Date.now()) >= ARCHIVE_GRACE_MS;
  };
  // the manifest's bring_to_front choices; a device that never opened its settings has the default
  const focusOn = (trigger: 'start' | 'update') =>
    ctx.devices.some(d => {
      if (!d.connected) return false;
      const mode = ctx.config(d).bring_to_front ?? 'When one starts';
      return mode === 'When one starts or updates' || (mode === 'When one starts' && trigger === 'start');
    });
  // ios rewrites archives without visible changes, so an update is a change in what the activity says
  const lastTexts = new Map<string, string>();

  // views ride along only for activities that changed, so the heartbeat stays tiny
  const snapshot = (withViews: Set<string> | 'all') => {
    const full = (id: string) => withViews === 'all' || withViews.has(id);
    return json({
      type: 'snapshot',
      at: Date.now(),
      problem,
      icons: Object.fromEntries(
        shown.filter(a => full(a.id) && icons.get(a.bundleId)).map(a => [a.bundleId, icons.get(a.bundleId)!]),
      ),
      activities: shown.map(a => {
        const r = rendered.get(a.id)!;
        return {
          id: a.id,
          bundleId: a.bundleId,
          appName: a.appName,
          startedAt: a.startedAt,
          updatedAt: a.updatedAt,
          staleAt: a.staleAt,
          content: a.content,
          texts: r.texts,
          rev: r.rev,
          ...(full(a.id) ? { views: r.views } : {}),
        };
      }),
    });
  };

  let running = false;
  let again = false;
  const refresh = async () => {
    // fs events arrive in bursts; never let two refreshes interleave
    if (running) return void (again = true);
    running = true;
    try {
      const next = readActivities();
      if (problem) setProblem(null);
      const before = new Set(shown.map(a => a.id));
      const changed = new Set<string>();
      for (const a of next) {
        if (!firstSeen.has(a.id)) {
          firstSeen.set(a.id, Date.now());
          setTimeout(() => void refresh(), ARCHIVE_GRACE_MS + 50);
        }
        if (rendered.get(a.id)?.rev === revOf(a)) continue;
        try {
          rendered.set(a.id, await render(a, gap));
        } catch (err) {
          ctx.log.warn(`could not decode ${a.appName}'s archive: ${(err as Error).message}`);
          rendered.set(a.id, { rev: revOf(a), views: {}, texts: [] });
        }
        await iconFor(a.bundleId);
        changed.add(a.id);
      }
      const live = new Set(next.map(a => a.id));
      for (const id of [...rendered.keys()]) if (!live.has(id)) (rendered.delete(id), firstSeen.delete(id));
      const nowShown = next.filter(ready);
      const started = nowShown.filter(a => !before.has(a.id));
      for (const a of started) changed.add(a.id);
      const removed = shown.some(a => !live.has(a.id) || !nowShown.some(b => b.id === a.id));
      const ended = shown.length > 0 && nowShown.length === 0;
      shown = nowShown;
      for (const a of started) ctx.log.info(`+ ${a.appName}`);
      if (changed.size || removed) ctx.broadcast(snapshot(changed));
      const updated = nowShown.some(a => {
        const said = rendered.get(a.id)!.texts.join('\n');
        const before = lastTexts.get(a.id);
        lastTexts.set(a.id, said);
        return before !== undefined && before !== said;
      });
      for (const id of [...lastTexts.keys()]) if (!live.has(id)) lastTexts.delete(id);
      const trigger = started.length ? 'start' : updated ? 'update' : null;
      if (trigger && focusOn(trigger)) tookOver = (await bringForward(ctx.webapp.id)) > 0 || tookOver;
      if (ended && tookOver) (await restore(ctx.webapp.id), (tookOver = false));
    } catch (err) {
      setProblem(problemFromError(err));
    } finally {
      running = false;
      if (again) (again = false), void refresh();
    }
  };

  const sendAll = (device: Device) => device.active && device.send(snapshot('all'));
  ctx.on('device', event => {
    if (event.type === 'connected' || event.type === 'active') sendAll(event.device);
  });
  ctx.on('message', (device, message) => {
    if (asJson<{ type?: string }>(message)?.type === 'hello') sendAll(device);
  });

  const heartbeat = setInterval(() => ctx.broadcast(snapshot(new Set())), HEARTBEAT_MS);
  let stopWatching: (() => void) | undefined;
  // watching needs the stores to be readable; keep checking until they are, so granting access needs no restart
  const tryStart = () => {
    let found: Problem | null;
    try {
      found = diagnose();
    } catch (err) {
      found = problemFromError(err);
    }
    if (found && found.code !== 'never-synced') return setProblem(found);
    setProblem(found);
    if (stopWatching) return void refresh();
    try {
      stopWatching = watchActivities(() => void refresh());
    } catch (err) {
      return setProblem(problemFromError(err));
    }
    void refresh();
  };
  tryStart();
  const recheck = setInterval(() => (problem || !stopWatching) && tryStart(), RECHECK_MS);
  return () => {
    stopWatching?.();
    clearInterval(heartbeat);
    clearInterval(recheck);
  };
}

let stop: (() => void) | undefined;
defineExtension({
  start(ctx) {
    stop = start(ctx);
  },
  stop() {
    stop?.();
  },
});
