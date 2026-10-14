// decoder for swiftui archived views (chronokit .activity-archive, widget .archive / .chrono-timeline)
// see FORMAT.md for the layout this implements

import { isBplist, parseBplist } from './bplist';
import { f16, hex, Msg } from './proto';
import { parseFont, type Font } from './sfnt';
import { nameFamily, resolveSystemFont, type Evidence, type SystemFontResult } from './sysfont';

export { renderView } from './render';
export type { RenderOptions, RenderResult } from './render';

const MAGIC = 0xd1561a71;

export type Pt = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };
export type Affine = [number, number, number, number, number, number];
export type RGBA = [number, number, number, number]; // srgb-encoded 0..1

export type StateInfo = {
  index: number; // position in manifest.stateAttachments
  chunk: number;
  viewTag: string;
  size: { w: number; h: number };
  cornerRadius?: number;
  env: Record<string, unknown>; // the multi-valued environment keys only
  entry: number; // timeline entry, 0 for activities
  metadata?: unknown;
};

export type Archive = {
  bytes: Uint8Array;
  chunks: Uint8Array[];
  manifest: Record<string, any>;
  data: Record<string, any>;
  kind: 'activity' | 'widget';
  viewTags: string[];
  states: StateInfo[];
  chunk(i: number): Uint8Array;
  font(chunk: number): Font | undefined;
  systemFont(chunk: number): SystemFontResult; // a font descriptor chunk resolved against installed fonts
  rb(chunk: number): RBList | undefined;
  stableId(identity: number): string | undefined; // stableIDs attachment: identity -> stable hash (hex)
};

export function readArchive(bytes: Uint8Array): Archive {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || dv.getUint32(bytes.length - 4, true) !== MAGIC) throw new Error('not a swiftui archive');
  const count = dv.getUint32(bytes.length - 8, true);
  const idx = bytes.length - 8 - 16 * count;
  if (idx < 0) throw new Error('bad chunk index');
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const off = Number(dv.getBigUint64(idx + 16 * i, true));
    const len = Number(dv.getBigUint64(idx + 16 * i + 8, true));
    chunks.push(bytes.subarray(off, off + len));
  }
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  const manifest = JSON.parse(text(chunks[count - 1]!));
  const raw = chunks[manifest.dataAttachment];
  if (!raw) throw new Error('missing data attachment');
  const data = (isBplist(raw) ? parseBplist(raw) : JSON.parse(text(raw))) as Record<string, any>;
  const stateChunks: number[] = manifest.stateAttachments ?? [];

  const states: StateInfo[] = [];
  let kind: Archive['kind'];
  let viewTags: string[];
  if (Array.isArray(data.viewTags)) {
    kind = 'activity';
    viewTags = data.viewTags;
    // viewEntryMetadata is one entry per state; the env product is per tag family
    const meta: any[] = data.viewEntryMetadata ?? [];
    const seen = new Map<string, number>();
    meta.forEach((m, i) => {
      const tag: string = m.viewTag;
      const family = tag.startsWith('dynamicIsland') ? 'dynamicIsland' : tag;
      const k = seen.get(tag) ?? 0;
      seen.set(tag, k + 1);
      const [w = 0, h = 0] = m.metrics?.bounds?.[1] ?? [];
      states.push({
        index: i,
        chunk: stateChunks[i]!,
        viewTag: tag,
        size: { w, h },
        cornerRadius: m.metrics?.cornerRadius,
        ...envCombo(data[family]?.environment ?? {}, k),
        metadata: m.listItemViewMetadata,
      });
    });
  } else {
    kind = 'widget';
    viewTags = ['widget'];
    stateChunks.forEach((c, i) => {
      const s = new Msg(chunks[c] ?? new Uint8Array()).msg(1);
      states.push({
        index: i,
        chunk: c,
        viewTag: 'widget',
        size: { w: s?.float(1) ?? 0, h: s?.float(2) ?? 0 },
        ...envCombo(data.environment ?? {}, i),
        metadata: data.viewMetadata?.[i],
      });
    });
  }

  const fonts = new Map<number, Font | undefined>();
  const sysFonts = new Map<number, SystemFontResult>();
  let stableIds: Map<number, string> | undefined;
  let evidence: Evidence[] | undefined;
  // embedded subsets: {1 font bytes, 2 name, repeated 3 {1 original gid, 2 subset gid}}
  const embedded = (): Evidence[] => {
    if (evidence) return evidence;
    evidence = [];
    chunks.forEach((c, i) => {
      if (c[0] !== 0x0a || !c.length) return;
      let m: Msg;
      try {
        m = new Msg(c);
      } catch {
        return;
      }
      const name = m.str(2);
      const pairs = m.msgs(3).map((p) => [p.int(1), p.int(2)] as [number, number]);
      if (!name || !pairs.length || !m.bytesOf(1)) return;
      const font = archive.font(i);
      if (font) evidence!.push({ family: nameFamily(name), version: name, font, pairs });
    });
    return evidence;
  };
  const rbs = new Map<number, RBList | undefined>();
  const archive: Archive = {
    bytes,
    chunks,
    manifest,
    data,
    kind,
    viewTags,
    states,
    chunk: (i) => chunks[i] ?? new Uint8Array(0),
    font(c) {
      if (!fonts.has(c)) {
        let f: Font | undefined;
        try {
          const m = new Msg(chunks[c] ?? new Uint8Array());
          const sf = m.bytesOf(1);
          if (sf) f = parseFont(sf, m.str(2) ?? '');
        } catch {}
        fonts.set(c, f);
      }
      return fonts.get(c);
    },
    systemFont(c) {
      let r = sysFonts.get(c);
      if (!r) {
        const m = Msg.from({ no: 0, wt: 2, v: 0, raw: chunks[c] ?? new Uint8Array() });
        const ps = m.str(3) ?? m.str(5) ?? '';
        const coords: Record<string, number> = {};
        const vars = plistAt(m.bytesOf(10));
        try {
          // variation axes keyed by four-char code as a decimal string
          for (const [k, v] of Object.entries(typeof vars === 'string' ? JSON.parse(vars) : (vars ?? {})))
            coords[String.fromCharCode(...[24, 16, 8, 0].map((sh) => (Number(k) >>> sh) & 255))] = Number(v);
        } catch {}
        r = ps ? resolveSystemFont(ps, coords, embedded()) : { family: '', reason: 'font descriptor without a name' };
        sysFonts.set(c, r);
      }
      return r;
    },
    stableId(id) {
      if (!stableIds) {
        stableIds = new Map();
        try {
          // { repeated 1 { 1 identity, 2 StableIdentity { 1 hash, 2 serial } } }
          for (const e of new Msg(chunks[manifest.stableIDsAttachment] ?? new Uint8Array()).msgs(1)) {
            const h = e.msg(2)?.msg(1);
            if (h) stableIds.set(e.int(1), hex(h.bytesOf(1) ?? h.bytes));
          }
        } catch {}
      }
      return stableIds.get(id);
    },
    rb(c) {
      if (!rbs.has(c)) {
        let r: RBList | undefined;
        try {
          if (chunks[c]) r = decodeRBChunk(new Msg(chunks[c]));
        } catch {}
        rbs.set(c, r);
      }
      return rbs.get(c);
    },
  };
  return archive;
}

// states are the row-major product of the multi-valued env keys in sorted order (last key fastest)
export function envKeys(env: Record<string, unknown>): string[] {
  return Object.keys(env)
    .filter((k) => Array.isArray(env[k]) && (env[k] as unknown[]).length > 1)
    .sort();
}

// anything left over after the env product is the timeline entry (outermost)
function envCombo(env: Record<string, unknown>, index: number): { env: Record<string, unknown>; entry: number } {
  const out: Record<string, unknown> = {};
  const keys = envKeys(env);
  let rest = index;
  for (let i = keys.length - 1; i >= 0; i--) {
    const vals = env[keys[i]!] as unknown[];
    out[keys[i]!] = vals[rest % vals.length];
    rest = Math.floor(rest / vals.length);
  }
  return { env: out, entry: rest };
}

// ---------------------------------------------------------------- swiftui display list

export type Node = {
  frame: Rect;
  id?: number;
  content?: Content;
  effect?: Effect;
  children?: Node[];
  states?: { hash: string; children: Node[] }[];
};

export type Content =
  | { kind: 'color'; color: RGBA }
  | { kind: 'image'; image: Img }
  | { kind: 'shape'; shape: Shape; paint: Paint }
  | { kind: 'shadow'; shape: Shape; color: RGBA; radius: number; dx: number; dy: number }
  | { kind: 'drawing'; chunk: number; offset: Pt }
  | { kind: 'flattened'; children: Node[]; offset: Pt }
  | { kind: 'text'; text: string; color?: RGBA; size?: { w: number; h: number }; fontChunk?: number; align: TextAlign; timer?: Timer; tabular?: boolean }
  | { kind: 'platformView'; name: string; chunk?: number }
  | { kind: 'backdrop'; color?: RGBA }
  | { kind: 'unknown'; field: number };

export type TextAlign = 'start' | 'middle' | 'end';
// date-relative text; times are unix ms
export type Timer = { style: string; start?: number; end?: number; countdown: boolean };
export type FontDesc = { name: string; size: number; weight: number; rounded: boolean; monospacedDigits: boolean };
// a progress view archived as a platform view; times are unix ms
export type Progress = { start?: number; end?: number; countdown: boolean; fraction?: number; tint?: RGBA };

export type Img = {
  source: { kind: 'bitmap'; chunk: number } | { kind: 'vector'; chunk: number; size: { w: number; h: number } } | { kind: 'color'; color: RGBA } | { kind: 'none' };
  scale: number;
  pixelSize: { w: number; h: number };
  tint?: RGBA; // template rendering colour
};

export type StrokeStyle = {
  width: number;
  cap: 'butt' | 'round' | 'square';
  join: 'miter' | 'round' | 'bevel';
  miter: number;
  dash?: number[];
  dashPhase?: number;
};
const CAPS = ['butt', 'round', 'square'] as const;
const JOINS = ['miter', 'round', 'bevel'] as const;
const f32s = (b: Uint8Array | undefined): number[] | undefined => {
  if (!b || b.length < 4) return undefined;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return Array.from({ length: Math.floor(b.length / 4) }, (_, i) => dv.getFloat32(4 * i, true));
};
export type PathPart = { d: string; stroke?: StrokeStyle };
export type Shape = { parts: PathPart[]; eo?: boolean; bounds?: Rect; badOp?: number };

export type Stop = { color: RGBA; at: number };
export type Paint =
  | { kind: 'color'; color: RGBA }
  | { kind: 'linear'; stops: Stop[]; from: Pt; to: Pt; units: 'unit' | 'abs' }
  | { kind: 'radial'; stops: Stop[]; center: Pt; r0: number; r1: number }
  | { kind: 'angular'; stops: Stop[]; center: Pt; start: number; end: number }
  | { kind: 'unknown'; field: number };

export type Filter =
  | { kind: 'blur'; radius: number }
  | { kind: 'shadow'; color: RGBA; radius: number; dx: number; dy: number }
  | { kind: 'matrix'; m: number[] } // 4x5 row-major
  | { kind: 'saturation'; v: number }
  | { kind: 'brightness'; v: number }
  | { kind: 'multiply'; color: RGBA }
  | { kind: 'luminanceToAlpha' }
  | { kind: 'unknown'; field: number };

export type Effect =
  | { kind: 'opacity'; value: number }
  | { kind: 'transform'; m: Affine }
  | { kind: 'clip'; shape: Shape }
  | { kind: 'mask'; children: Node[] }
  | { kind: 'filter'; filters: Filter[] }
  | { kind: 'blend'; mode: number }
  | { kind: 'group'; name?: string }
  | { kind: 'accessibility'; label?: string; traits?: number }
  | { kind: 'transition'; transition: Transition }
  | { kind: 'passthrough'; field: number };

// ContentTransition.State: what iOS does when this subtree's content changes between archive versions
export type Transition = {
  kind: 'default' | 'identity' | 'opacity' | 'interpolate' | 'text' | 'numericText' | 'custom' | 'unknown';
  countsDown?: boolean; // numericText fixed direction
  value?: number; // numericText automatic(value:)
  style?: 'sessionWidget' | 'animatedWidget';
};

export function decodeState(a: Archive, s: StateInfo): { size: { w: number; h: number }; nodes: Node[] } {
  const m = new Msg(a.chunk(s.chunk));
  const sz = m.msg(1);
  return { size: { w: sz?.float(1) ?? s.size.w, h: sz?.float(2) ?? s.size.h }, nodes: decodeList(m.msg(2)) };
}

const rect = (m: Msg | undefined): Rect => ({ x: m?.float(1) ?? 0, y: m?.float(2) ?? 0, w: m?.float(3) ?? 0, h: m?.float(4) ?? 0 });
const pt = (m: Msg | undefined): Pt => ({ x: m?.float(1) ?? 0, y: m?.float(2) ?? 0 });
const affine = (m: Msg | undefined): Affine => [m?.float(1, 1) ?? 1, m?.float(2) ?? 0, m?.float(3) ?? 0, m?.float(4, 1) ?? 1, m?.float(5) ?? 0, m?.float(6) ?? 0];

export const lin2srgb = (v: number) => {
  const a = Math.abs(v);
  const s = a <= 0.0031308 ? a * 12.92 : 1.055 * a ** (1 / 2.4) - 0.055;
  return Math.sign(v) * s;
};

// Color.Resolved: linear extended srgb floats, opacity defaults to 1
function resolvedColor(m: Msg | undefined): RGBA {
  return [lin2srgb(m?.float(1) ?? 0), lin2srgb(m?.float(2) ?? 0), lin2srgb(m?.float(3) ?? 0), m?.float(4, 1) ?? 1];
}

export function decodeList(m: Msg | undefined): Node[] {
  return m ? m.msgs(1).map(decodeNode) : [];
}

function decodeNode(m: Msg): Node {
  const n: Node = { frame: rect(m.msg(3)) };
  if (m.has(4)) n.id = m.int(4);
  const c = m.msg(1);
  if (c) n.content = decodeContent(c.msg(1));
  const e = m.msg(2);
  if (e) {
    n.effect = decodeEffect(e.msg(1));
    n.children = decodeList(e.msg(2));
  }
  const s = m.msg(5);
  if (s) n.states = s.msgs(1).map((st) => ({ hash: hex(st.msg(1)?.bytesOf(1) ?? new Uint8Array()), children: decodeList(st.msg(2)) }));
  return n;
}

function decodeContent(v: Msg | undefined): Content {
  const f = v?.fields[0];
  if (!v || !f) return { kind: 'unknown', field: 0 };
  const m = Msg.from(f);
  switch (f.no) {
    case 1:
      return { kind: 'color', color: resolvedColor(m) };
    case 2:
      return { kind: 'image', image: decodeImage(m) };
    case 3:
      return { kind: 'shape', shape: decodePath(m.msg(1)), paint: decodePaint(m.msg(2)) };
    case 4:
      return decodeAttributedText(m);
    case 5: {
      // shadow of a shape (the shape itself is a separate item): {1 Path, 2 {1 color, 2 radius, 3 offset}}
      const st = m.msg(2);
      const off = st?.msg(3);
      return { kind: 'shadow', shape: decodePath(m.msg(1)), color: resolvedColor(st?.msg(1)), radius: st?.float(2) ?? 0, dx: off?.float(1) ?? 0, dy: off?.float(2) ?? 0 };
    }
    case 6:
      return { kind: 'flattened', children: decodeList(m.msg(1)), offset: pt(m.msg(2)) };
    case 7:
      return { kind: 'platformView', name: m.str(1) ?? '', chunk: m.msg(2)?.int(1, -1) };
    case 11: {
      const col = m.msg(2);
      return { kind: 'backdrop', color: col ? resolvedColor(col) : undefined };
    }
    case 13:
      return { kind: 'drawing', chunk: m.msg(1)?.int(1) ?? -1, offset: pt(m.msg(2)) };
    default:
      return { kind: 'unknown', field: f.no };
  }
}

// text the system lays out at display time: date-relative text (timers) and placeholders.
// { 1 { repeated 1 run { 1 utf8, 2 attrs }, 4 bplist timer source, 5 paragraph }, 2 layout size }
// attrs { 2 utf16 length, 3 {1 font descriptor chunk}, 4 Color.Resolved, 34/35 bplist format runs }
function decodeAttributedText(m: Msg): Content {
  const body = m.msg(1);
  const runs = body?.msgs(1) ?? [];
  const attrs = runs[0]?.msg(2);
  const sz = m.msg(2);
  const col = attrs?.msg(4);
  const format = plistAt(attrs?.bytesOf(35));
  const fmt = format?.value?.format;
  const align = (['start', 'middle', 'end'] as const)[fmt?.textAlignment?.value ?? 0] ?? 'start';
  return {
    kind: 'text',
    text: runs.map((r) => new TextDecoder().decode(r.bytesOf(1) ?? new Uint8Array())).join(''),
    color: col ? resolvedColor(col) : undefined,
    size: sz ? { w: sz.float(1), h: sz.float(2) } : undefined,
    fontChunk: attrs?.msg(3)?.int(1, -1),
    align,
    tabular: !!fmt?.monospacedDigits,
    timer: decodeTimer(plistAt(body?.bytesOf(4)), format),
  };
}

const appleMs = (d: unknown) => (d instanceof Date ? d.getTime() : typeof d === 'number' ? (d + 978307200) * 1000 : undefined);

function plistAt(b: Uint8Array | undefined): any {
  if (!b || !isBplist(b)) return undefined;
  try {
    const p = parseBplist(b);
    return Array.isArray(p) ? p[0] : p;
  } catch {
    return undefined;
  }
}

// the timer source plist carries the interval; the format plist names the style and counting direction
function decodeTimer(src: any, format: any): Timer | undefined {
  const type: string = format?.type ?? '';
  const fmt = format?.value?.format;
  const style = type.match(/SystemFormatStyleO\d+(?:\d+)?([A-Z][A-Za-z]*?)V/)?.[1]?.toLowerCase() ?? (src?.timerInterval ? 'timer' : undefined);
  if (!style && !src) return undefined;
  const ti = src?.timerInterval;
  let start = appleMs(ti?.start ?? fmt?.startDate ?? src?.date);
  let end: number | undefined;
  if (ti && typeof ti.duration === 'number' && start !== undefined) end = start + ti.duration * 1000;
  else if (Array.isArray(fmt?.interval) && start !== undefined) {
    // swift Duration as (seconds-ish high word, attoseconds low word) of a 128-bit attosecond count
    const [hi, lo] = fmt.interval as [number, number];
    end = start + (hi * 2 ** 64 + lo) / 1e15;
  }
  const countdown = !!(src?.countdowns ?? fmt?.countingMode?.timer?.countsdown);
  if (start === undefined && end === undefined) return undefined;
  return { style: style ?? 'timer', start, end, countdown };
}

// font descriptor chunk: { 3 postscript name, 5 ui font name, 7 size, 9 features plist, 10 variations plist }
export function decodeFontDesc(b: Uint8Array): FontDesc | undefined {
  let m: Msg;
  try {
    m = new Msg(b);
  } catch {
    return undefined;
  }
  const name = m.str(5) ?? m.str(3) ?? '';
  const size = m.float(7);
  if (!name && !size) return undefined;
  const json = (no: number) => {
    const p = plistAt(m.bytesOf(no));
    try {
      return typeof p === 'string' ? JSON.parse(p) : p;
    } catch {
      return undefined;
    }
  };
  const vars = json(10);
  const feats: any[] = json(9) ?? [];
  // 'wght' axis tag as a four-char code
  let weight = Number(vars?.[String(0x77676874)]);
  if (!weight) {
    const n = name.toLowerCase();
    const table: [string, number][] = [['ultralight', 100], ['thin', 200], ['light', 300], ['medium', 500], ['semibold', 600], ['demi', 600], ['heavy', 800], ['black', 900], ['bold', 700]];
    weight = table.find(([k]) => n.includes(k))?.[1] ?? 400;
  }
  return {
    name,
    size,
    weight,
    rounded: /rounded/i.test(name),
    // feature type 6 selector 0 is monospaced numbers
    monospacedDigits: feats.some((f) => f?.CTFeatureTypeIdentifier === 6 && f?.CTFeatureSelectorIdentifier === 0),
  };
}

// archived progress view state: { size, view { interval [start, end], countdown, resolvedTint, value/total } }
export function decodeProgress(b: Uint8Array): Progress | undefined {
  const p = plistAt(b);
  const v = p?.view;
  if (!v) return undefined;
  const iv = Array.isArray(v.interval) ? v.interval : undefined;
  const t = v.resolvedTint;
  let fraction: number | undefined;
  if (typeof v.fractionCompleted === 'number') fraction = v.fractionCompleted;
  else if (typeof v.value === 'number') fraction = v.value / (typeof v.total === 'number' && v.total ? v.total : 1);
  return {
    start: appleMs(iv?.[0]),
    end: appleMs(iv?.[1]),
    countdown: !!v.countdown,
    fraction,
    tint: Array.isArray(t) && t.length >= 3 ? [t[0], t[1], t[2], t[3] ?? 1] : undefined,
  };
}

function decodeImage(m: Msg): Img {
  const px = m.msg(6);
  const img: Img = { source: { kind: 'none' }, scale: m.float(5, 1), pixelSize: { w: px?.float(1) ?? 0, h: px?.float(2) ?? 0 } };
  if (m.has(1)) img.source = { kind: 'color', color: resolvedColor(m.msg(1)) };
  else if (m.has(2)) img.source = { kind: 'bitmap', chunk: m.msg(2)!.int(1, -1) };
  else if (m.has(3)) {
    const v = m.msg(3)!;
    const sz = v.msg(2);
    img.source = { kind: 'vector', chunk: v.msg(1)?.int(1, -1) ?? -1, size: { w: sz?.float(1) ?? 0, h: sz?.float(2) ?? 0 } };
  }
  if (m.has(8)) img.tint = resolvedColor(m.msg(8));
  return img;
}

// swiftui Path: 1 rect, 2 ellipse, 3 rounded rect, 4 renderbox path data
export function decodePath(m: Msg | undefined): Shape {
  if (!m) return { parts: [] };
  if (m.has(1)) {
    const r = rect(m.msg(1));
    return { parts: [{ d: rectD(r) }], bounds: r };
  }
  if (m.has(2)) {
    const r = rect(m.msg(2));
    return { parts: [{ d: ellipseD(r) }], bounds: r };
  }
  if (m.has(3)) {
    const rr = m.msg(3)!;
    const r = rect(rr.msg(1));
    const cs = rr.msg(2);
    return { parts: [{ d: rrectD(r, cs?.float(1) ?? 0, cs?.float(2) ?? 0, rr.int(3) === 1) }], bounds: r };
  }
  if (m.has(4)) {
    const { parts, badOp } = rbPath(m.msg(4)!);
    return { parts, badOp };
  }
  return { parts: [] };
}

function decodeStops(g: Msg | undefined, packed?: { colors?: Uint8Array; locs?: Uint8Array }): Stop[] {
  if (packed?.colors) {
    const c = packed.colors;
    const dv = new DataView(c.buffer, c.byteOffset, c.byteLength);
    const locs = packed.locs ? new DataView(packed.locs.buffer, packed.locs.byteOffset, packed.locs.byteLength) : undefined;
    const n = c.length / 8;
    return Array.from({ length: n }, (_, i) => ({
      color: [0, 1, 2, 3].map((k) => f16(dv.getUint16(8 * i + 2 * k, true))) as RGBA,
      at: locs && locs.byteLength >= 4 * (i + 1) ? locs.getFloat32(4 * i, true) : n > 1 ? i / (n - 1) : 0,
    }));
  }
  return (g?.msgs(1) ?? []).map((s) => ({ color: resolvedColor(s.msg(1)), at: s.float(2) }));
}

function decodePaint(m: Msg | undefined): Paint {
  const f = m?.fields[0];
  if (!m || !f) return { kind: 'color', color: [0, 0, 0, 1] };
  const p = Msg.from(f);
  switch (f.no) {
    case 1:
      return { kind: 'color', color: resolvedColor(p) };
    case 2: {
      const from = p.msg(2);
      const to = p.msg(3);
      return { kind: 'linear', stops: decodeStops(p.msg(1)), from: pt(from), to: pt(to), units: 'unit' };
    }
    case 10:
      return { kind: 'linear', stops: decodeStops(p.msg(1)), from: pt(p.msg(2)), to: pt(p.msg(3)), units: 'abs' };
    case 3:
      return { kind: 'radial', stops: decodeStops(p.msg(1)), center: pt(p.msg(2)), r0: p.float(3), r1: p.float(4) };
    case 4:
      return { kind: 'angular', stops: decodeStops(p.msg(1)), center: pt(p.msg(2)), start: p.float(3), end: p.float(4, Math.PI * 2) };
    default:
      return { kind: 'unknown', field: f.no };
  }
}

function decodeEffect(m: Msg | undefined): Effect {
  const f = m?.fields[0];
  if (!m || !f) return { kind: 'passthrough', field: 0 };
  const e = Msg.from(f);
  switch (f.no) {
    case 3:
      return { kind: 'opacity', value: m.float(3, 1) };
    case 4:
      return { kind: 'blend', mode: e?.int(1) ?? 0 };
    case 5:
      return { kind: 'clip', shape: { ...decodePath(e?.msg(1)), eo: e?.msg(2)?.bool(1) ?? false } };
    case 6:
      return { kind: 'mask', children: decodeList(e?.msg(1)) };
    case 7:
      return { kind: 'transform', m: affine(e) };
    case 9:
      return { kind: 'filter', filters: e ? [decodeFilter(e)] : [] };
    case 12:
      return { kind: 'group', name: e?.str(1) };
    case 14:
      return accessibility(e);
    case 16:
      return { kind: 'transition', transition: decodeTransition(e) };
    case 21: {
      // rotation: angle (radians) about an anchor point in local space
      const a = e?.float(1) ?? 0;
      const c = pt(e?.msg(2));
      const [cos, sin] = [Math.cos(a), Math.sin(a)];
      return { kind: 'transform', m: [cos, sin, -sin, cos, c.x - cos * c.x + sin * c.y, c.y - sin * c.x - cos * c.y] };
    }
    case 22: {
      // rotation3d flattened to the affine it projects to without perspective
      const a = e?.float(1) ?? 0;
      const [ax, ay] = [e?.float(2) ?? 0, e?.float(3) ?? 0];
      const [cx, cy] = [e?.float(5) ?? 0, e?.float(6) ?? 0];
      const len = Math.hypot(ax, ay, e?.float(4) ?? 0) || 1;
      const sx = 1 - (1 - Math.cos(a)) * (ay / len) ** 2;
      const sy = 1 - (1 - Math.cos(a)) * (ax / len) ** 2;
      return { kind: 'transform', m: [sx, 0, 0, sy, cx - sx * cx, cy - sy * cy] };
    }
    default:
      return { kind: 'passthrough', field: f.no };
  }
}

// State { 1 ContentTransition { 1 named, 2 custom {1 method, repeated 2 effect}, 3 replaceable }, 2 style, 3 animation,
// 4 options }. named: one field per name plus 8 style; numericText { 1 downwards, 2 automatic value, 3 ? }
function decodeTransition(e: Msg): Transition {
  const t = e.msg(1);
  const styleOf = (m: Msg | undefined) => (m?.has(1) ? 'sessionWidget' : m?.has(2) ? 'animatedWidget' : undefined);
  const named = t?.msg(1);
  const style = styleOf(named?.msg(8) ?? e.msg(2));
  if (!named) return { kind: t?.has(2) ? 'custom' : 'unknown', style };
  const f = named.fields.find((x) => x.no !== 8);
  const kinds: Transition['kind'][] = ['unknown', 'default', 'identity', 'opacity', 'interpolate', 'text', 'numericText'];
  const out: Transition = { kind: (f && kinds[f.no]) || (f ? 'unknown' : 'default'), style };
  if (f?.no === 6) {
    const n = Msg.from(f);
    if (n.has(1)) out.countsDown = n.int(1) === 1;
    if (n.has(2)) out.value = n.float(2);
  }
  return out;
}

function decodeFilter(m: Msg): Filter {
  const f = m.fields[0];
  if (!f) return { kind: 'unknown', field: 0 };
  const p = Msg.from(f);
  switch (f.no) {
    case 1:
      return { kind: 'blur', radius: p?.float(1) ?? 0 };
    case 2: {
      const off = p?.msg(3);
      return { kind: 'shadow', color: resolvedColor(p?.msg(1)), radius: p?.float(2) ?? 0, dx: off?.float(1) ?? 0, dy: off?.float(2) ?? 0 };
    }
    case 4: {
      const id = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
      return { kind: 'matrix', m: id.map((v, i) => p?.float(i + 1, v) ?? v) };
    }
    case 14: {
      // rgb-only 3x5 matrix, alpha row untouched
      const id = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0];
      return { kind: 'matrix', m: [...id.map((v, i) => p?.float(i + 1, v) ?? v), 0, 0, 0, 1, 0] };
    }
    case 5:
      return { kind: 'multiply', color: resolvedColor(p) };
    case 7:
      return { kind: 'saturation', v: m.float(7, 1) };
    case 8:
      return { kind: 'brightness', v: m.float(8, 0) };
    case 10:
      return { kind: 'luminanceToAlpha' };
    default:
      return { kind: 'unknown', field: f.no };
  }
}

function accessibility(e: Msg | undefined): Effect {
  const props = e?.msg(1)?.msg(1)?.msg(3)?.msg(1);
  const t = props?.msg(2)?.msg(3)?.msg(2)?.bytesOf(1);
  const label = t && !(t[0]! >= 0xf0) ? new TextDecoder().decode(t) : undefined;
  return { kind: 'accessibility', label, traits: props?.msg(6)?.int(1) };
}

// ---------------------------------------------------------------- renderbox paths

const n2 = (v: number) => +v.toFixed(3);
type PtFmt = (x: number, y: number) => string;
const plain: PtFmt = (x, y) => `${n2(x)} ${n2(y)}`;
const mapper = (t: Affine | undefined): PtFmt => (t ? (x, y) => plain(t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]) : plain);

export const rectD = (r: Rect, P = plain) => `M${P(r.x, r.y)}L${P(r.x + r.w, r.y)}L${P(r.x + r.w, r.y + r.h)}L${P(r.x, r.y + r.h)}Z`;

export function ellipseD(r: Rect, P = plain): string {
  const [rx, ry, cx, cy] = [r.w / 2, r.h / 2, r.x + r.w / 2, r.y + r.h / 2];
  let d = `M${P(cx + rx, cy)}`;
  for (let q = 0; q < 4; q++) d += arcCubic(cx, cy, rx, ry, (q * Math.PI) / 2, ((q + 1) * Math.PI) / 2, P);
  return d + 'Z';
}

// continuous corners approximated by pulling the cubic controls closer to the corner
export function rrectD(r: Rect, rx: number, ry: number, continuous = false, P = plain): string {
  return unevenRRectD(r, [rx, rx, rx, rx], [ry, ry, ry, ry], continuous, P);
}

// radii order: top-leading, bottom-leading, bottom-trailing, top-trailing (swiftui RectangleCornerRadii)
function unevenRRectD(r: Rect, rxs: number[], rys: number[], continuous: boolean, P = plain): string {
  const k = continuous ? 0.62 : 0.5523;
  const cl = (v: number, max: number) => Math.max(0, Math.min(v, max));
  const c = (i: number): [number, number] => [cl(rxs[i] ?? 0, r.w / 2), cl(rys[i] ?? 0, r.h / 2)];
  const [tl, bl, br, tr] = [c(0), c(1), c(2), c(3)];
  const { x, y, w, h } = r;
  const corner = (x0: number, y0: number, cx: number, cy: number, x1: number, y1: number) =>
    `C${P(x0 + (cx - x0) * k, y0 + (cy - y0) * k)} ${P(x1 + (cx - x1) * k, y1 + (cy - y1) * k)} ${P(x1, y1)}`;
  let d = `M${P(x + tl[0], y)}L${P(x + w - tr[0], y)}`;
  if (tr[0] || tr[1]) d += corner(x + w - tr[0], y, x + w, y, x + w, y + tr[1]);
  d += `L${P(x + w, y + h - br[1])}`;
  if (br[0] || br[1]) d += corner(x + w, y + h - br[1], x + w, y + h, x + w - br[0], y + h);
  d += `L${P(x + bl[0], y + h)}`;
  if (bl[0] || bl[1]) d += corner(x + bl[0], y + h, x, y + h, x, y + h - bl[1]);
  d += `L${P(x, y + tl[1])}`;
  if (tl[0] || tl[1]) d += corner(x, y + tl[1], x, y, x + tl[0], y);
  return d + 'Z';
}

function arcCubic(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, P: PtFmt): string {
  const k = (4 / 3) * Math.tan((a1 - a0) / 4);
  const [c0, s0, c1, s1] = [Math.cos(a0), Math.sin(a0), Math.cos(a1), Math.sin(a1)];
  return `C${P(cx + rx * (c0 - k * s0), cy + ry * (s0 + k * c0))} ${P(cx + rx * (c1 + k * s1), cy + ry * (s1 - k * c1))} ${P(cx + rx * c1, cy + ry * s1)}`;
}

// opcode stream over a float32 array. low 7 bits = op, high bit = consumes the next field-4 parameter.
// 0 move 1 line 2 quad 3 cubic 4 close 5 rect 7 ellipse 8/9 rrect (circular/continuous) 10/11 uneven rrect
// 13/14 arc (-/+ sweep) 17 begin transform 19 begin stroke 20 begin union 21 next operand 16 end group
export function rbPath(m: Msg, base?: Affine): { parts: PathPart[]; badOp?: number } {
  const ops = m.bytesOf(3) ?? new Uint8Array();
  const pb = m.bytesOf(2) ?? new Uint8Array();
  const f = new DataView(pb.buffer, pb.byteOffset, pb.byteLength);
  const extra = m.msg(4);
  const xforms = extra?.msgs(1) ?? [];
  const styles = extra?.msgs(2) ?? [];
  let fi = 0;
  const take = (n: number) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++, fi++) out.push(fi * 4 + 4 <= pb.length ? f.getFloat32(fi * 4, true) : 0);
    return out;
  };
  const stack: { stroke?: StrokeStyle; xf?: Affine }[] = [{ xf: base }];
  const parts: PathPart[] = [];
  let d = '';
  const P: PtFmt = (x, y) => {
    let t: Affine | undefined;
    for (const fr of stack) if (fr.xf) t = t ? mul(t, fr.xf) : fr.xf;
    return mapper(t)(x, y);
  };
  const flush = () => {
    if (!d) return;
    const stroke = stack.findLast((s) => s.stroke)?.stroke;
    parts.push(stroke ? { d, stroke } : { d });
    d = '';
  };
  let ti = 0;
  let si = 0;
  for (const raw of ops) {
    const op = raw & 0x7f;
    const flag = raw & 0x80;
    switch (op) {
      case 0:
      case 1: {
        const [x, y] = take(2) as [number, number];
        d += (op ? 'L' : 'M') + P(x, y);
        break;
      }
      case 2: {
        const [a, b, x, y] = take(4) as [number, number, number, number];
        d += `Q${P(a, b)} ${P(x, y)}`;
        break;
      }
      case 3: {
        const [a, b, c, e, x, y] = take(6) as [number, number, number, number, number, number];
        d += `C${P(a, b)} ${P(c, e)} ${P(x, y)}`;
        break;
      }
      case 4:
        d += 'Z';
        break;
      case 5:
      case 7:
      case 8:
      case 9:
      case 10:
      case 11: {
        const v = take(op >= 10 ? 8 : op >= 8 ? 6 : 4);
        const r = { x: v[0]!, y: v[1]!, w: v[2]!, h: v[3]! };
        if (op === 5) d += rectD(r, P);
        else if (op === 7) d += ellipseD(r, P);
        else if (op <= 9) d += rrectD(r, v[4]!, v[5]!, op === 9, P);
        else d += unevenRRectD(r, v.slice(4), v.slice(4), op === 11, P);
        break;
      }
      case 13:
      case 14: {
        const [cx, cy, rad, a0, a1] = take(5) as [number, number, number, number, number];
        let delta = a1 - a0;
        if (op === 14) while (delta < 0) delta += 2 * Math.PI;
        else while (delta > 0) delta -= 2 * Math.PI;
        d += (d ? 'L' : 'M') + P(cx + rad * Math.cos(a0), cy + rad * Math.sin(a0));
        const steps = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
        for (let i = 0; i < steps; i++) d += arcCubic(cx, cy, rad, rad, a0 + (delta * i) / steps, a0 + (delta * (i + 1)) / steps, P);
        break;
      }
      case 17:
        flush();
        stack.push({ xf: flag ? affine(xforms[ti++]) : undefined });
        break;
      case 19: {
        flush();
        // header floats: width, miter limit, dash phase; style {1 cap, 2 join, 3 packed f32 dash lengths}
        const [w, miter, phase] = take(3) as [number, number, number];
        const st = flag ? styles[si++] : undefined;
        const cap = CAPS[st?.int(1) ?? 0] ?? 'butt';
        const join = JOINS[st?.int(2) ?? 0] ?? 'miter';
        const dash = f32s(st?.bytesOf(3));
        stack.push({ stroke: { width: w, miter, cap, join, ...(dash ? { dash, dashPhase: phase } : {}) } });
        break;
      }
      case 20:
        flush();
        stack.push({});
        break;
      case 21:
        flush();
        break;
      case 16:
        flush();
        if (stack.length > 1) stack.pop();
        break;
      default:
        flush();
        return { parts, badOp: raw };
    }
  }
  flush();
  return { parts };
}

export const mul = (a: Affine, b: Affine): Affine => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];

// ---------------------------------------------------------------- renderbox display lists (attachments)

export type RBFont = { kind: 'embedded'; chunk: number } | { kind: 'system'; chunk: number; name?: string };
// clip resources intersect: each entry is a shape under its own transform
export type RBClip = { shape: RBShape; m: Affine };
export type RBResource = { id: number; font?: RBFont; clip?: RBClip[]; image?: number /* chunk */ };
export type RBList = { entries: RBEntry[]; resources: Map<number, RBResource> };
export type RBShape =
  | { kind: 'path'; parts: PathPart[]; eo?: boolean; badOp?: number }
  | { kind: 'glyphs'; font: number; glyphs: { gid: number; x: number }[] }
  | { kind: 'fill' }
  | { kind: 'unknown'; field: number };
export type RBPaint =
  | { kind: 'color'; color: RGBA }
  | { kind: 'linear'; stops: Stop[]; from: Pt; to: Pt }
  // image fill: the bitmap's unit square is mapped onto the shape by m; the colour modulates it
  | { kind: 'image'; resource: number; m: Affine; color?: RGBA }
  | { kind: 'unknown'; field: number };
export type RBEntry = {
  item?: { shape: RBShape; paint: RBPaint; m: Affine };
  group?: RBList;
  alpha?: number;
  blend?: number;
  clip?: number; // resource id
};

function decodeRBChunk(m: Msg): RBList {
  const resources = new Map<number, RBResource>();
  for (const r of m.msgs(15)) {
    const id = r.int(1);
    const res: RBResource = { id };
    const fr = r.msg(3)?.msg(1);
    if (fr?.has(3)) res.font = { kind: 'embedded', chunk: fr.msg(3)!.int(1, -1) };
    else if (fr?.has(4)) res.font = { kind: 'system', chunk: fr.msg(4)!.int(1, -1) };
    if (r.has(2)) res.image = r.msg(2)?.msg(1)?.msg(1)?.int(1, -1);
    if (r.has(4)) res.clip = r.msg(4)!.msgs(1).map((c) => ({ shape: decodeRBShape(c.msg(1)?.msg(1)), m: affine(c.msg(1)?.msg(2)) }));
    resources.set(id, res);
  }
  return decodeRBList(m.msg(1) ?? Msg.from(undefined), resources);
}

function decodeRBList(m: Msg, resources: Map<number, RBResource>): RBList {
  return { entries: m.msgs(1).map((e) => decodeRBEntry(e, resources)), resources };
}

function decodeRBEntry(m: Msg, resources: Map<number, RBResource>): RBEntry {
  const e: RBEntry = {};
  const it = m.msg(1);
  if (it) e.item = { shape: decodeRBShape(it.msg(1)), paint: decodeRBPaint(it.msg(2)), m: affine(it.msg(3)) };
  if (m.has(2)) e.group = decodeRBList(m.msg(2)!.msg(1) ?? Msg.from(undefined), resources);
  if (m.has(4)) e.alpha = m.float(4, 1);
  if (m.has(5)) e.blend = m.int(5);
  if (m.has(6)) e.clip = m.msg(6)!.int(1);
  return e;
}

function decodeRBShape(m: Msg | undefined): RBShape {
  const f = m?.fields[0];
  if (!m || !f) return { kind: 'unknown', field: 0 };
  const s = Msg.from(f);
  switch (f.no) {
    case 1: {
      // rect primitive: 1 corner style, 2 rect, 3 radius, 6 stroke width; no rect means unbounded
      if (!s.has(2)) return { kind: 'fill' };
      const r = rect(s.msg(2));
      const rad = s.float(3);
      const d = rad ? rrectD(r, rad, rad, s.int(1) === 4) : rectD(r);
      const w = s.float(6);
      return { kind: 'path', parts: [w ? { d, stroke: { width: w, cap: 'butt', join: 'miter', miter: 10 } } : { d }] };
    }
    case 2: {
      const { parts, badOp } = rbPath(s.msg(1) ?? Msg.from(undefined), s.has(2) ? affine(s.msg(2)) : undefined);
      return { kind: 'path', parts, eo: s.int(3) === 1, badOp };
    }
    case 3: {
      // stroked path: 1 path data, 2 transform, 3 width, 4 cap, 5 join, 6 packed f32 dashes, 7 miter limit
      const stroke: StrokeStyle = { width: s.float(3, 1), cap: CAPS[s.int(4)] ?? 'butt', join: JOINS[s.int(5)] ?? 'miter', miter: s.float(7, 10) };
      const dash = f32s(s.bytesOf(6));
      if (dash) stroke.dash = dash;
      const { parts, badOp } = rbPath(s.msg(1) ?? Msg.from(undefined), s.has(2) ? affine(s.msg(2)) : undefined);
      return { kind: 'path', parts: parts.map((p) => ({ ...p, stroke: p.stroke ?? stroke })), badOp };
    }
    case 5:
      return {
        kind: 'glyphs',
        font: s.msg(1)?.int(1) ?? 0,
        glyphs: s.msgs(2).map((g) => ({ gid: g.int(1), x: g.float(2) })),
      };
    default:
      return { kind: 'unknown', field: f.no };
  }
}

function f16Color(raw: Uint8Array | undefined): RGBA {
  if (!raw || raw.length < 8) return [0, 0, 0, 1];
  const dv = new DataView(raw.buffer, raw.byteOffset, 8);
  return [0, 1, 2, 3].map((k) => f16(dv.getUint16(2 * k, true))) as RGBA;
}

function decodeRBPaint(m: Msg | undefined): RBPaint {
  const f = m?.fields[0];
  if (!m || !f) return { kind: 'color', color: [0, 0, 0, 1] };
  const p = Msg.from(f);
  switch (f.no) {
    case 1: {
      const c = f16Color(p.get(1)?.raw);
      // colour space 2 is extended linear
      return { kind: 'color', color: p.int(2) === 2 ? [lin2srgb(c[0]), lin2srgb(c[1]), lin2srgb(c[2]), c[3]] : c };
    }
    case 2:
      return { kind: 'linear', stops: decodeStops(undefined, { colors: p.bytesOf(1), locs: p.bytesOf(2) }), from: pt(p.msg(7)), to: pt(p.msg(8)) };
    case 3: {
      const c = p.msg(4);
      return { kind: 'image', resource: p.msg(1)?.int(1) ?? 0, m: affine(p.msg(3)), color: c ? f16Color(c.get(1)?.raw) : undefined };
    }
    default:
      return { kind: 'unknown', field: f.no };
  }
}
