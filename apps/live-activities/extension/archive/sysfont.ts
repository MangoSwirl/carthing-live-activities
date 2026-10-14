// resolves glyph runs whose font the archive names but does not embed (ios system fonts) against fonts installed
// on this mac. glyph ids are only trusted when the archive's own embedded subsets of the same family agree with the
// installed font, since ios and macos often ship different builds of sf.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseFont, type Font } from './sfnt';

const FONT_DIRS = ['/System/Library/Fonts', '/Library/Fonts'];

// ios ui font families and the macos files that carry the same design
const IOS_TO_MACOS_FAMILY: Record<string, string> = {
  '.SFUI': '.SFNS',
  '.SFUIRounded': '.SFNSRounded',
  '.SFUIMono': '.SFNSMono',
  '.SFUIItalic': '.SFNSItalic',
};

type Installed = { path: string; ps: string; family: string };
let index: Installed[] | undefined;

// postscript family: ".SFUI-Regular_wdth_opsz110000" -> ".SFUI"
const psFamily = (ps: string) => ps.split('-')[0]!.replace(/\s+/g, '');
// embedded subset name field: ".SF UI Rounded; 22.0d3e2; 2026-05-08" -> ".SFUIRounded"
export const nameFamily = (name: string) => name.split(';')[0]!.replace(/\s+/g, '');

function installed(): Installed[] {
  if (index) return index;
  index = [];
  for (const dir of FONT_DIRS) {
    let files: string[] = [];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/\.(ttf|otf)$/i.test(f)) continue;
      const path = join(dir, f);
      try {
        const ps = psName(readFileSync(path));
        if (ps) index.push({ path, ps, family: psFamily(ps) });
      } catch {}
    }
  }
  return index;
}

// name id 6 without parsing the whole font
function psName(b: Uint8Array): string | undefined {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const n = dv.getUint16(4);
  for (let i = 0; i < n; i++) {
    const r = 12 + 16 * i;
    if (String.fromCharCode(...b.subarray(r, r + 4)) !== 'name') continue;
    const t = dv.getUint32(r + 8);
    const count = dv.getUint16(t + 2);
    const str = t + dv.getUint16(t + 4);
    for (let k = 0; k < count; k++) {
      const e = t + 6 + 12 * k;
      if (dv.getUint16(e + 6) !== 6) continue;
      const [pid, len, off] = [dv.getUint16(e), dv.getUint16(e + 8), str + dv.getUint16(e + 10)];
      if (pid === 1) return String.fromCharCode(...b.subarray(off, off + len));
      let s = '';
      for (let j = 0; j < len; j += 2) s += String.fromCharCode(dv.getUint16(off + j));
      return s;
    }
  }
  return undefined;
}

const fonts = new Map<string, Font>();

export type SystemFontResult = { font?: Font; family: string; file?: string; reason?: string };

// evidence: embedded subsets from the same archive as (family, font, [original gid, subset gid][])
export type Evidence = { family: string; version?: string; font: Font; pairs: [number, number][] };

export function resolveSystemFont(ps: string, coords: Record<string, number>, evidence: Evidence[]): SystemFontResult {
  const family = psFamily(ps);
  const want = IOS_TO_MACOS_FAMILY[family] ?? family;
  let list: Installed[];
  try {
    list = installed();
  } catch {
    return { family, reason: 'no font directories readable' };
  }
  const hit = list.find((f) => f.family === want) ?? list.find((f) => f.family === family);
  if (!hit) return { family, reason: `no installed font for ${family}` };
  const key = `${hit.path}|${JSON.stringify(coords)}`;
  let font = fonts.get(key);
  if (!font) {
    try {
      font = parseFont(new Uint8Array(readFileSync(hit.path)), hit.ps, coords);
    } catch {
      return { family, file: hit.path, reason: 'installed font unreadable' };
    }
    fonts.set(key, font);
  }
  // glyph ids must agree with what the device's own font produced for the subsets in this archive
  const byChar = new Map<string, number>();
  for (let g = font.numGlyphs - 1; g >= 0; g--) {
    const c = font.charFor(g);
    if (c) byChar.set(c, g);
  }
  let ok = 0;
  let bad = 0;
  for (const ev of evidence) {
    if (ev.family !== family) continue;
    for (const [orig, sub] of ev.pairs) {
      const c = ev.font.charFor(sub);
      if (!c) continue;
      if (byChar.get(c) === orig) ok++;
      else bad++;
    }
  }
  const dev = evidence.find((e) => e.family === family)?.version;
  if (bad) return { family, file: hit.path, reason: `installed ${font.version ?? hit.ps} glyph ids differ from the device's ${dev ?? family} (${bad} of ${ok + bad} mismatched)` };
  if (!ok) return { family, file: hit.path, reason: `no embedded ${family} subset in the archive to verify glyph ids against` };
  return { font, family, file: hit.path };
}
