// resolves glyph runs whose font the archive names but does not embed (ios system fonts) against fonts installed
// on this mac. glyph ids are only trusted when the archive's own embedded subsets of the same family agree with the
// installed font, since ios and macos often ship different builds of sf.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { namedInstances, parseFont, type Font } from './sfnt';

const FONT_DIRS = ['/System/Library/Fonts', '/Library/Fonts'];

// ios ui font families and the macos files that carry the same design
const IOS_TO_MACOS_FAMILY: Record<string, string> = {
  '.SFUI': '.SFNS',
  '.SFUIRounded': '.SFNSRounded',
  '.SFUIMono': '.SFNSMono',
  '.SFUIItalic': '.SFNSItalic',
};

type Installed = { path: string; face: number; ps: string; family: string };
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
      if (!/\.(ttf|otf|ttc)$/i.test(f)) continue;
      const path = join(dir, f);
      try {
        const b = new Uint8Array(readFileSync(path));
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        const ttc = String.fromCharCode(...b.subarray(0, 4)) === 'ttcf';
        const faces = ttc ? dv.getUint32(8) : 1;
        for (let face = 0; face < faces; face++) {
          const ps = psName(b, ttc ? dv.getUint32(12 + 4 * face) : 0);
          if (ps) index.push({ path, face, ps, family: psFamily(ps) });
        }
      } catch {}
    }
  }
  return index;
}

// name id 6 without parsing the whole font
function psName(b: Uint8Array, dir: number): string | undefined {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const n = dv.getUint16(dir + 4);
  for (let i = 0; i < n; i++) {
    const r = dir + 12 + 16 * i;
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

// unverified: the installed font instanced at the archived axes when its glyph ids could not be trusted; usable only
// through characters (cmap), never with the archive's glyph ids
export type SystemFontResult = { font?: Font; family: string; file?: string; reason?: string; unverified?: Font };

// evidence: embedded subsets from the same archive as (family, font, [original gid, subset gid][])
export type Evidence = { family: string; version?: string; font: Font; pairs: [number, number][]; chunk?: number };

function load(hit: Installed, coords: Record<string, number>): Font | undefined {
  const key = `${hit.path}#${hit.face}|${JSON.stringify(coords)}`;
  let font = fonts.get(key);
  if (!font) {
    try {
      font = parseFont(new Uint8Array(readFileSync(hit.path)), hit.ps, coords, hit.face);
    } catch {
      return undefined;
    }
    fonts.set(key, font);
  }
  return font;
}

// local: the archive was rendered on this mac, so the installed fonts are the ones it used
export function resolveSystemFont(ps: string, coords: Record<string, number>, evidence: Evidence[], local = false): SystemFontResult {
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
  const font = load(hit, coords);
  if (!font) return { family, file: hit.path, reason: 'installed font unreadable' };
  if (local) return { font, family, file: hit.path };
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
  if (bad) return { family, file: hit.path, unverified: font, reason: `installed ${font.version ?? hit.ps} glyph ids differ from the device's ${dev ?? family} (${bad} of ${ok + bad} mismatched)` };
  if (!ok) return { family, file: hit.path, unverified: font, reason: `no embedded ${family} subset in the archive to verify glyph ids against` };
  return { font, family, file: hit.path };
}

// fonts for text the system lays out at display time. there are no glyph ids to trust, only characters, so any
// installed build of the family will do; a different build only moves outlines and advances slightly
export function resolveTextFont(ps: string | undefined, uiName: string, coords: Record<string, number>, rounded = false, url?: string): SystemFontResult {
  // an app-registered font names its file; use it when this machine has that file (mac apps), never otherwise
  const own = url ? fileFont(url, ps, coords) : undefined;
  if (own) return own;
  const family = ps ? psFamily(ps) : rounded || /rounded/i.test(uiName) ? '.SFUIRounded' : /mono/i.test(uiName) ? '.SFUIMono' : '.SFUI';
  const want = IOS_TO_MACOS_FAMILY[family] ?? family;
  let list: Installed[];
  try {
    list = installed();
  } catch {
    return { family, reason: 'no font directories readable' };
  }
  const hit = (ps && list.find((f) => f.ps === ps)) || list.find((f) => f.family === want) || list.find((f) => f.family === family);
  if (!hit) return { family, reason: `no installed font for ${family}` };
  // a postscript name that is one of the face's named instances pins every axis (width, weight, grade...)
  if (ps && hit.ps !== ps) {
    try {
      const inst = namedInstances(new Uint8Array(readFileSync(hit.path)), hit.face).find((i) => i.ps === ps);
      if (inst) coords = { ...inst.coords, ...(coords.opsz !== undefined ? { opsz: coords.opsz } : {}) };
    } catch {}
  } else if (coords.wdth !== undefined && coords.wght !== undefined) {
    // at another width the named weights sit at other wght values (SemiCondensed Semibold is 650, not 590):
    // map the weight through the standard-width instances onto the instances at the asked width
    try {
      coords = { ...coords, wght: remapWeight(namedInstances(new Uint8Array(readFileSync(hit.path)), hit.face), coords.wdth, coords.wght) };
    } catch {}
  }
  const font = load(hit, coords);
  return font ? { font, family, file: hit.ps } : { family, file: hit.path, reason: 'installed font unreadable' };
}

// piecewise-linear map from the wdth 100 instances' weights to the same-index instances at wdth
function remapWeight(insts: { coords: Record<string, number> }[], wdth: number, wght: number): number {
  const at = (w: number) => insts.filter((i) => i.coords.wdth === w).map((i) => i.coords.wght!);
  const from = at(100);
  const to = at(wdth);
  if (from.length < 2 || from.length !== to.length) return wght;
  let k = 1;
  while (k < from.length - 1 && wght > from[k]!) k++;
  const t = (wght - from[k - 1]!) / (from[k]! - from[k - 1]!);
  return to[k - 1]! + Math.max(0, Math.min(1, t)) * (to[k]! - to[k - 1]!);
}

// a font file the archive points at (font descriptor field 2), when it exists here; ttc faces are matched by name
function fileFont(url: string, ps: string | undefined, coords: Record<string, number>): SystemFontResult | undefined {
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return undefined;
  }
  if (!/^file:/i.test(url) || !existsSync(path)) return undefined;
  try {
    const b = new Uint8Array(readFileSync(path));
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const ttc = String.fromCharCode(...b.subarray(0, 4)) === 'ttcf';
    const faces = ttc ? dv.getUint32(8) : 1;
    let face = 0;
    for (let i = 0; i < faces; i++) if (psName(b, ttc ? dv.getUint32(12 + 4 * i) : 0) === ps) face = i;
    const name = psName(b, ttc ? dv.getUint32(12 + 4 * face) : 0) ?? ps ?? '';
    const hit: Installed = { path, face, ps: name, family: psFamily(name) };
    const font = load(hit, coords);
    return font ? { font, family: hit.family, file: path } : undefined;
  } catch {
    return undefined;
  }
}
