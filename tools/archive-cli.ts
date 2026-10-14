// bun mac/archive/cli.ts <archive> [--tag listItem] [--light] [--lum] [--redaction n] [--state i] [--png out.png [--bg #000]]
//   [--json] [--states] [--raw chunk] [--now ms|iso]
// png previews paint the activity's background tint as a rounded card when it has one

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { decodeState, readArchive, renderView } from '../apps/live-activities/extension/archive/decode';
import { dumpMsg } from '../apps/live-activities/extension/archive/proto';
import { pickState, type RenderOptions } from '../apps/live-activities/extension/archive/render';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCALE = 3;

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = args.find((a, i) => !a.startsWith('--') && !['--tag', '--png', '--redaction', '--state', '--bg', '--raw', '--now'].includes(args[i - 1] ?? ''));
if (!file) {
  console.error('usage: bun mac/archive/cli.ts <archive> [--tag listItem] [--light] [--lum] [--redaction n] [--state i] [--png out.png [--bg #000]] [--json] [--states] [--raw chunk] [--now ms|iso]');
  process.exit(2);
}

const archive = readArchive(new Uint8Array(readFileSync(file)));
const opts: RenderOptions = {
  viewTag: opt('--tag'),
  colorScheme: flag('--light') ? 'light' : 'dark',
  luminanceReduced: flag('--lum'),
  redaction: opt('--redaction') ? Number(opt('--redaction')) : undefined,
  stateIndex: opt('--state') ? Number(opt('--state')) : undefined,
  now: opt('--now') ? (/^\d+$/.test(opt('--now')!) ? Number(opt('--now')) : Date.parse(opt('--now')!)) : undefined,
};

if (opt('--raw')) {
  console.log(JSON.stringify(dumpMsg(archive.chunk(Number(opt('--raw')))), null, 1));
  process.exit(0);
}

if (flag('--states')) {
  for (const s of archive.states) console.log(s.index, `chunk=${s.chunk}`, s.viewTag, `${+s.size.w.toFixed(2)}x${+s.size.h.toFixed(2)}`, JSON.stringify(s.env));
  process.exit(0);
}

if (flag('--json')) {
  const st = pickState(archive, opts);
  if (!st) throw new Error('no matching state');
  const tree = decodeState(archive, st);
  // inline the renderbox attachments so the dump is readable on its own
  const seen = new Set<number>();
  const rbs: Record<number, unknown> = {};
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if ((o.kind === 'drawing' || o.kind === 'vector') && typeof o.chunk === 'number' && !seen.has(o.chunk)) {
      seen.add(o.chunk);
      const rb = archive.rb(o.chunk);
      rbs[o.chunk] = rb && { ...rb, resources: Object.fromEntries(rb.resources) };
    }
    Object.values(o).forEach(walk);
  };
  walk(tree);
  console.log(JSON.stringify({ state: st, manifest: archive.manifest, tree, attachments: rbs }, (_, v) => (typeof v === 'number' ? +v.toFixed(4) : v), 1));
  process.exit(0);
}

const out = renderView(archive, opts);
if (!out) {
  console.error('no matching view');
  process.exit(1);
}
for (const w of out.warnings) console.error('warning:', w);
console.error(`state ${out.state.index} (chunk ${out.state.chunk}) ${out.state.viewTag} ${JSON.stringify(out.state.env)}`);
console.error('texts:', JSON.stringify(out.texts));
if (out.backgroundTint) console.error('backgroundTint:', JSON.stringify(out.backgroundTint), 'textColor:', JSON.stringify(out.textColor));

const png = opt('--png');
if (!png) {
  process.stdout.write(out.svg + '\n');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'archive-'));
  const html = join(dir, 'view.html');
  const [w, h] = [Math.ceil(out.width * SCALE), Math.ceil(out.height * SCALE)];
  const bt = out.backgroundTint;
  const card = bt ? `background:rgba(${bt.slice(0, 3).map((v) => Math.round(v * 255)).join(',')},${bt[3]});border-radius:${(out.cornerRadius ?? 0) * SCALE}px` : '';
  writeFileSync(
    html,
    `<!doctype html><html><head><style>html,body{margin:0;background:${opt('--bg') ?? 'transparent'}}svg{display:block;width:${w}px;height:${h}px;${card}}</style></head><body>${out.svg}</body></html>`,
  );
  const p = Bun.spawnSync([CHROME, '--headless', '--disable-gpu', '--hide-scrollbars', `--screenshot=${resolve(png)}`, `--window-size=${w},${h}`, '--default-background-color=00000000', `file://${html}`], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  rmSync(dir, { recursive: true, force: true });
  if (p.exitCode !== 0) {
    console.error(new TextDecoder().decode(p.stderr));
    process.exit(1);
  }
  console.error(`wrote ${png} (${w}x${h})`);
}
