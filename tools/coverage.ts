// decodes every swiftui archive on this mac and tallies what the decoder could not recognise or draw, most common
// first, with example files. the work list for decoder gaps.
//
//   bun tools/coverage.ts [--out report.md] [--all-states]
//
// sources: the iphone archives chronod keeps, every mac widget extension's own timelines and placeholders, and the
// live activity history the bridge kept. needs full disk access.

import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readArchive, renderView } from '../apps/live-activities/extension/archive/decode';

const args = process.argv.slice(2);
const outPath = args.includes('--out') ? args[args.indexOf('--out') + 1]! : '/tmp/decoder-coverage.md';
const allStates = args.includes('--all-states');

const roots = [
  join(homedir(), 'Library/Group Containers/group.com.apple.chronod/chronod/remoteArchives'),
  join(homedir(), 'Library/Containers'),
  join(homedir(), 'Library/Caches/carthing-live-activities/archives'),
];

function* archives(dir: string, depth = 0): Generator<string> {
  if (depth > 9) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const p = join(dir, n);
    // mac containers hold far more than widgets; only descend where chronod keeps archives
    if (depth === 1 && dir.endsWith('Library/Containers') && n !== 'Data') continue;
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (dir.endsWith('/Containers') && depth === 0) {
        yield* archives(join(p, 'Data/SystemData/com.apple.chrono'), depth + 2);
        continue;
      }
      yield* archives(p, depth + 1);
    } else if (/\.(chrono-timeline|activity-archive)$/.test(n)) yield p;
  }
}

type Tally = { count: number; files: Set<string>; details: Set<string> };
const unknowns = new Map<string, Tally>();
const warnings = new Map<string, Tally>();
const errors = new Map<string, Tally>();
// files the os will not let us open (some containers stay protected even with full disk access): not decoder errors
const unreadable = new Map<string, Tally>();
const add = (map: Map<string, Tally>, code: string, file: string, detail?: string) => {
  const t = map.get(code) ?? { count: 0, files: new Set(), details: new Set() };
  t.count++;
  t.files.add(file);
  if (detail && t.details.size < 5) t.details.add(detail);
  map.set(code, t);
};
// warnings carry ids and numbers; fold them into stable codes so they group
const normalise = (w: string) => w.replace(/\b\d+(\.\d+)?\b/g, n => (n.length > 3 ? '#' : n)).replace(/0x[0-9a-f]+/gi, '0x…');

let files = 0;
let states = 0;
for (const root of roots) {
  for (const file of archives(root)) {
    files++;
    const short = file.replace(homedir(), '~');
    let archive: ReturnType<typeof readArchive>;
    try {
      archive = readArchive(new Uint8Array(Bun.file(file).size ? await Bun.file(file).arrayBuffer() : new ArrayBuffer(0)));
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'EPERM' || err.code === 'EACCES') add(unreadable, `${err.code} ${short.split('/').slice(0, 4).join('/')}`, short);
      else add(errors, `readArchive: ${normalise(err.message).slice(0, 120)}`, short);
      continue;
    }
    for (const u of ((archive as unknown as { unknowns?: { code: string; detail?: string }[] }).unknowns ?? [])) add(unknowns, u.code, short, u.detail);
    const indices = allStates ? archive.states.map((_, i) => i) : [0];
    for (const stateIndex of indices) {
      states++;
      try {
        const v = renderView(archive, { stateIndex });
        if (!v) continue;
        for (const w of v.warnings) add(warnings, normalise(w), short);
        for (const u of ((v as unknown as { unknowns?: { code: string; detail?: string }[] }).unknowns ?? [])) add(unknowns, u.code, short, u.detail);
      } catch (e) {
        add(errors, `renderView: ${normalise((e as Error).message).slice(0, 120)}`, short);
      }
    }
  }
}

const section = (title: string, map: Map<string, Tally>) => {
  const rows = [...map].sort((a, b) => b[1].files.size - a[1].files.size || b[1].count - a[1].count);
  if (!rows.length) return `## ${title}\n\nnone\n`;
  return (
    `## ${title}\n\n| code | archives | times | example | values |\n| --- | --- | --- | --- | --- |\n` +
    rows
      .map(([code, t]) => `| \`${code}\` | ${t.files.size} | ${t.count} | ${[...t.files][0]!.split('/').slice(-3).join('/').slice(0, 70)} | ${[...t.details].join(', ').slice(0, 60)} |`)
      .join('\n') +
    '\n'
  );
};

const report =
  `# decoder coverage\n\n${files} archives, ${states} states rendered, ${new Date().toISOString()}\n\n` +
  section('errors', errors) +
  '\n' +
  section('unrecognised data', unknowns) +
  '\n' +
  section('warnings (known but approximated or not drawn)', warnings) +
  '\n' +
  section('unreadable files (permission denied, not decoded)', unreadable);
writeFileSync(outPath, report);
console.log(`${files} archives: ${errors.size} error kinds, ${unknowns.size} unknown kinds, ${warnings.size} warning kinds, ${[...unreadable.values()].reduce((n, t) => n + t.files.size, 0)} unreadable -> ${outPath}`);
