// decoder for swiftui archived views (chronokit .activity-archive, widget .archive / .chrono-timeline)
// see FORMAT.md for the layout this implements

import { isBplist, parseBplist } from './bplist';
import { checkUnread, collecting, f16, hex, Msg, preview, reportAll, unknown, Unknowns, type Unknown } from './proto';
import { parseFont, type Font } from './sfnt';
import { parseType1 } from './type1';
import { nameFamily, resolveSystemFont, resolveTextFont, type Evidence, type SystemFontResult } from './sysfont';

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
  textFont(desc: FontDesc): SystemFontResult; // an installed font to shape display-time text with
  local: boolean; // rendered by this mac (widget extensions here), so installed fonts match what it drew with
  rb(chunk: number): RBList | undefined;
  // a glyph id a run uses that its embedded subset does not have: CoreGraphics leaves glyphs it did not subset under
  // their original ids. resolved through any same-family subset that maps that original id, else the installed
  // family font when the archive's subsets verify its glyph ids
  missingGlyph(chunk: number, gid: number): { font: Font; gid: number; key: string } | undefined;
  stableId(identity: number): string | undefined; // stableIDs attachment: identity -> stable hash (hex)
  unknowns: Unknown[]; // unrecognised manifest/data keys (rendering adds its own)
};

// local: the archive was drawn on this mac (its fonts are the ones it used); detected from the data when omitted
export function readArchive(bytes: Uint8Array, opts: { local?: boolean } = {}): Archive {
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
  const found = new Unknowns();
  collecting(found, () => checkKeys(manifest, data));

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
      // snapshot timelines keep keyed-archive bitmaps here instead of a display list
      const s = Msg.from({ no: 0, wt: 2, v: 0, raw: chunks[c] ?? new Uint8Array() }).msg(1);
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
  // deviceIdentifier.local means local to whichever device drew it. macos bundles nest plugins under Contents/, ios
  // bundles do not, which also catches ios-platform widgets running on this mac (platform 2, e.g. Stocks)
  const url: string = data.extensionBundle?.url?.relative ?? '';
  const local =
    opts.local ??
    (data.extensionBundle?.identifier?.deviceIdentifier?.local !== undefined && (data.systemVersion?.platform === 1 || /\.app\/Contents\//.test(url)));
  const textFonts = new Map<string, SystemFontResult>();
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
      if (font) evidence!.push({ family: nameFamily(name), version: name, font, pairs, chunk: i });
    });
    return evidence;
  };
  const rbs = new Map<number, RBList | undefined>();
  const rbUnknowns = new Map<number, Unknown[]>();
  const archive: Archive = {
    unknowns: found.list(),
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
          // 3: { 1 glyph id in the original font, 2 glyph id the drawing uses }
          m.ignore(3);
          if (sf && sf[0] === 0x25 && sf[1] === 0x21) f = type1Font(sf, m.str(2) ?? '', m.msgs(3));
          else if (sf) f = parseFont(sf, m.str(2) ?? '');
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
        r = ps ? resolveSystemFont(ps, coords, embedded(), local) : { family: '', reason: 'font descriptor without a name' };
        sysFonts.set(c, r);
      }
      return r;
    },
    local,
    textFont(desc) {
      // optical size follows the point size, as the system font does
      const coords: Record<string, number> = { wght: desc.weight, opsz: desc.size, ...(desc.width ? { wdth: desc.width } : {}) };
      const key = `${desc.ps ?? desc.name}|${desc.rounded}|${desc.weight}|${desc.width}|${desc.size}|${desc.url ?? ''}`;
      let r = textFonts.get(key);
      if (!r) textFonts.set(key, (r = resolveTextFont(desc.ps, desc.name, coords, desc.rounded, desc.url)));
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
    missingGlyph(c, gid) {
      const own = embedded().find((e) => e.chunk === c);
      const name = own?.version ?? new Msg(chunks[c] ?? new Uint8Array()).str(2) ?? '';
      const family = nameFamily(name);
      for (const e of embedded()) {
        if (e.family !== family || e.version !== name) continue;
        const hit = e.pairs.find(([orig]) => orig === gid);
        if (hit && e.font.glyphPath(hit[1])) return { font: e.font, gid: hit[1], key: `${e.chunk}:${hit[1]}` };
      }
      if (!family) return undefined;
      const r = resolveSystemFont(family, {}, embedded(), local);
      return r.font && gid < r.font.numGlyphs ? { font: r.font, gid, key: `sys:${family}:${gid}` } : undefined;
    },
    rb(c) {
      if (!rbs.has(c)) {
        let r: RBList | undefined;
        const u = new Unknowns();
        try {
          if (chunks[c]) r = collecting(u, () => decodeRBChunk(new Msg(chunks[c]!)));
        } catch {}
        rbs.set(c, r);
        rbUnknowns.set(c, u.list());
      }
      // decoded once, but every render that draws the chunk reports what it did not understand
      reportAll(rbUnknowns.get(c) ?? []);
      return rbs.get(c);
    },
  };
  return archive;
}

// keys of the json/bplist attachments we understand or knowingly skip; anything else is reported as bplist-key:<path>
const KNOWN_KEYS: Record<string, string[]> = {
  manifest: ['archiveID', 'dataAttachment', 'deploymentVersion', 'encoding', 'encodingStyle', 'intelligenceContentAttachments', 'linkedOnVersion', 'majorVersion', 'preferredBundleLanguage', 'preferredCompositionLanguage', 'stableIDsAttachment', 'stateAttachments'],
  activity: ['id', 'version', 'activityState', 'listItem', 'dynamicIsland', 'updateTimestamp', 'isInternal', 'viewEntryMetadata', 'viewTags'],
  widget: ['archiveVersion', 'creationDate', 'entryMetadata', 'environment', 'extensionBundle', 'reloadPolicy', 'systemVersion', 'viewMetadata', 'widget'],
  viewEntryMetadata: ['viewTag', 'metrics', 'listItemViewMetadata'],
  'viewEntryMetadata.metrics': ['bounds', 'cornerRadius'],
  'viewEntryMetadata.listItemViewMetadata': ['backgroundTintColor', 'textColor'],
  listItem: ['environment', 'archivedFamily'],
  dynamicIsland: ['environment', 'keyColor', 'widgetURL'],
  viewMetadata: ['containsInteractiveControls', 'containsPrivacyRedactions', 'supportsForeground', 'url'],
  entryMetadata: ['date', 'relevance'],
};

function checkKeys(manifest: any, data: any) {
  const check = (path: string, o: any) => {
    if (!o || typeof o !== 'object' || Array.isArray(o) || o instanceof Uint8Array) return;
    const known = KNOWN_KEYS[path] ?? [];
    for (const k of Object.keys(o)) if (!known.includes(k)) unknown(`bplist-key:${path}.${k}`, keyPreview(o[k]));
  };
  check('manifest', manifest);
  const activity = Array.isArray(data.viewTags);
  check(activity ? 'activity' : 'widget', data);
  for (const m of data.viewEntryMetadata ?? []) {
    check('viewEntryMetadata', m);
    check('viewEntryMetadata.metrics', m?.metrics);
    check('viewEntryMetadata.listItemViewMetadata', m?.listItemViewMetadata);
  }
  check('listItem', data.listItem);
  check('dynamicIsland', data.dynamicIsland);
  for (const m of data.viewMetadata ?? []) check('viewMetadata', m);
  for (const m of data.entryMetadata ?? []) check('entryMetadata', m);
}

const keyPreview = (v: unknown) => {
  const s = v instanceof Uint8Array ? `bytes[${v.length}]` : JSON.stringify(v);
  return s && s.length > 40 ? s.slice(0, 40) + '…' : s;
};

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
  // a single-valued colour scheme still decides the default text colour
  const cs = env.colorScheme;
  if (out.colorScheme === undefined && Array.isArray(cs) && cs.length === 1) out.colorScheme = cs[0];
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
  | TextContent
  | { kind: 'platformView'; name: string; chunk?: number }
  | { kind: 'backdrop'; color?: RGBA; filters: Filter[] }
  | { kind: 'unknown'; field: number };

export type TextContent = {
  kind: 'text';
  text: string;
  color?: RGBA;
  size?: { w: number; h: number };
  fontChunk?: number;
  align: TextAlign;
  timer?: Timer;
  clock?: WallClock; // text showing the current wall-clock time, kept live by the system
  tabular?: boolean;
  spans: TextSpan[]; // attribute ranges in code points
  lineLimit?: number;
  minScale?: number; // minimumScaleFactor: the text shrinks down to this before it truncates
  padding?: [number, number, number, number]; // style padding top, leading, bottom, trailing: the frame includes it
  justify?: boolean; // justified paragraphs: every line but the last fills the width
  lineSpacing?: number; // points added between lines
  lineHeightMultiple?: number;
  maxLineHeight?: number;
  minLineHeight?: number;
  hyphenation?: number; // hyphenation factor: a word broken across lines gets a hyphen
  variants?: TextContent[]; // smaller size variants, tried in order when the text does not fit
};

export type TextAlign = 'start' | 'middle' | 'end';
export type TextSpan = {
  start: number;
  length: number;
  fontChunk?: number;
  color?: RGBA;
  spacing?: number; // kerning plus tracking, points after each character
  shadow?: { color: RGBA; radius: number; dx: number; dy: number };
};
// wall-clock text: an ICU date skeleton such as "Jmm", formatted in a time zone and locale
export type WallClock = { template: string; timeZone?: string; locale?: string };
// date-relative text; times are unix ms
export type Timer = { style: string; start?: number; end?: number; countdown: boolean };
export type FontDesc = {
  name: string;
  ps?: string;
  size: number;
  weight: number;
  width?: number; // 'wdth' axis value when the style asks for a non-standard width
  url?: string; // file url of an app-registered font
  rounded: boolean;
  monospacedDigits: boolean;
  features: string[]; // opentype tags for the CoreText features asked for (tnum, smcp, c2sc)
};
// a progress view archived as a platform view; times are unix ms
export type Progress = { start?: number; end?: number; countdown: boolean; fraction?: number; tint?: RGBA };

export type Img = {
  source: { kind: 'bitmap'; chunk: number } | { kind: 'vector'; chunk: number; size: { w: number; h: number } } | { kind: 'color'; color: RGBA } | { kind: 'none' };
  scale: number;
  pixelSize: { w: number; h: number };
  tint?: RGBA; // template rendering colour
  orientation?: number; // Image.Orientation raw value when not up
  resizing?: { tile: boolean; caps: [number, number, number, number] }; // cap insets top, leading, bottom, trailing (points)
  interpolation?: number; // 0 none (nearest neighbour), 1 low, 2 medium, 3 high
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
// anchor: the rect unit points are relative to, when it is not the shape's frame (paint field 7)
export type Paint =
  | { kind: 'color'; color: RGBA }
  | { kind: 'linear'; stops: Stop[]; from: Pt; to: Pt; units: 'unit' | 'abs'; anchor?: Rect }
  | { kind: 'radial'; stops: Stop[]; center: Pt; r0: number; r1: number; anchor?: Rect }
  | { kind: 'angular'; stops: Stop[]; center: Pt; start: number; end: number; anchor?: Rect }
  | { kind: 'unknown'; field: number };

export type Filter =
  | { kind: 'blur'; radius: number }
  // kind: ShadowStyle.Kind bits, 1 inner, 2 shadow only (the content itself is not drawn)
  | { kind: 'shadow'; color: RGBA; radius: number; dx: number; dy: number; inner?: boolean; only?: boolean }
  | { kind: 'matrix'; m: number[] } // 4x5 row-major
  | { kind: 'curve'; values: number[]; amount: number } // tone curve through evenly spaced points, mixed by amount
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
  | { kind: 'group'; name?: string; chunk?: number } // archived modifier; chunk holds its bplist state
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
  const m = Msg.from({ no: 0, wt: 2, v: 0, raw: a.chunk(s.chunk) });
  const sz = m.msg(1);
  const out = { size: { w: sz?.float(1) ?? s.size.w, h: sz?.float(2) ?? s.size.h }, nodes: decodeList(m.msg(2)) };
  checkUnread(sz, 'StateSize');
  checkUnread(m, 'State');
  return out;
}

const rect = (m: Msg | undefined): Rect => {
  const r = { x: m?.float(1) ?? 0, y: m?.float(2) ?? 0, w: m?.float(3) ?? 0, h: m?.float(4) ?? 0 };
  checkUnread(m, 'Rect');
  return r;
};
const pt = (m: Msg | undefined): Pt => {
  const r = { x: m?.float(1) ?? 0, y: m?.float(2) ?? 0 };
  checkUnread(m, 'Point');
  return r;
};
const affine = (m: Msg | undefined): Affine => {
  const r: Affine = [m?.float(1, 1) ?? 1, m?.float(2) ?? 0, m?.float(3) ?? 0, m?.float(4, 1) ?? 1, m?.float(5) ?? 0, m?.float(6) ?? 0];
  checkUnread(m, 'Affine');
  return r;
};

export const lin2srgb = (v: number) => {
  const a = Math.abs(v);
  const s = a <= 0.0031308 ? a * 12.92 : 1.055 * a ** (1 / 2.4) - 0.055;
  return Math.sign(v) * s;
};

// Color.Resolved: linear extended srgb floats, opacity defaults to 1
function resolvedColor(m: Msg | undefined): RGBA {
  const c: RGBA = [lin2srgb(m?.float(1) ?? 0), lin2srgb(m?.float(2) ?? 0), lin2srgb(m?.float(3) ?? 0), m?.float(4, 1) ?? 1];
  // 5: HDR headroom (Color.ResolvedHDR); every archive so far says 1, standard dynamic range, which is what we draw
  m?.ignore(5);
  checkUnread(m, 'Color');
  return c;
}

export function decodeList(m: Msg | undefined): Node[] {
  return m ? m.msgs(1).map(decodeNode) : [];
}

function decodeNode(m: Msg): Node {
  const n: Node = { frame: rect(m.msg(3)) };
  if (m.has(4)) n.id = m.int(4);
  const c = m.msg(1);
  if (c) {
    n.content = decodeContent(c.msg(1));
    // 2: content seed (a change counter), irrelevant to drawing
    c.ignore(2);
    checkUnread(c, 'ItemContent');
  }
  const e = m.msg(2);
  if (e) {
    n.effect = decodeEffect(e.msg(1));
    n.children = decodeList(e.msg(2));
    checkUnread(e, 'ItemEffect');
  }
  const s = m.msg(5);
  if (s) {
    n.states = s.msgs(1).map((st) => {
      const h = st.msg(1);
      const out = { hash: hex(h?.bytesOf(1) ?? new Uint8Array()), children: decodeList(st.msg(2)) };
      checkUnread(h, 'StrongHash');
      checkUnread(st, 'InteractionState');
      return out;
    });
    checkUnread(s, 'InteractionStates');
  }
  checkUnread(m, 'Item');
  return n;
}

function decodeContent(v: Msg | undefined): Content {
  const f = v?.first();
  if (!v || !f) return { kind: 'unknown', field: 0 };
  checkUnread(v, 'ContentValue');
  const m = Msg.from(f);
  const out = contentCase(f.no, m);
  if (out.kind === 'unknown') unknown(`content-field:${f.no}`, preview(f));
  else checkUnread(m, `Content.${out.kind}`);
  return out;
}

function contentCase(no: number, m: Msg): Content {
  switch (no) {
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
      const out: Content = { kind: 'shadow', shape: decodePath(m.msg(1)), color: resolvedColor(st?.msg(1)), radius: st?.float(2) ?? 0, dx: off?.float(1) ?? 0, dy: off?.float(2) ?? 0 };
      checkUnread(off, 'ShadowOffset');
      checkUnread(st, 'ShadowStyle');
      return out;
    }
    case 6:
      // 3: rasterization options, irrelevant to vector output
      m.ignore(3);
      return { kind: 'flattened', children: decodeList(m.msg(1)), offset: pt(m.msg(2)) };
    case 7: {
      const ref = m.msg(2);
      const out: Content = { kind: 'platformView', name: m.str(1) ?? '', chunk: ref?.int(1, -1) };
      checkUnread(ref, 'ChunkRef');
      return out;
    }
    case 11: {
      // material backdrop: 1 capture scale (a resolution hint), 2 tint colour drawn over it, repeated 3 filters
      // applied to what lies behind, in order (e.g. tone curve, saturation, brightness, blur 22.5)
      const col = m.msg(2);
      m.ignore(1);
      const filters = m.msgs(3).map(decodeFilter);
      return { kind: 'backdrop', color: col ? resolvedColor(col) : undefined, filters };
    }
    case 12:
      // chameleon colour: a fallback colour plus the filters that adapt it to vibrant rendering; draw the fallback
      m.ignore(2);
      return { kind: 'color', color: resolvedColor(m.msg(1)) };
    case 13: {
      const ref = m.msg(1);
      // 3: rasterization options, irrelevant to vector output
      m.ignore(3);
      const out: Content = { kind: 'drawing', chunk: ref?.int(1) ?? -1, offset: pt(m.msg(2)) };
      checkUnread(ref, 'ChunkRef');
      return out;
    }
    default:
      return { kind: 'unknown', field: no };
  }
}

// text the system lays out at display time: date-relative text (timers) and placeholders.
// Value 4 is { 1 CodableResolvedStyledText, 2 layout size }; see decodeTextBody
function decodeAttributedText(m: Msg): Content {
  const sz = m.msg(2);
  const out = decodeTextBody(m.msg(1), sz ? { w: sz.float(1), h: sz.float(2) } : undefined);
  checkUnread(sz, 'TextSize');
  return out;
}

// CodableResolvedStyledText { 1 attributed string { repeated 1 run { 1 utf8, 2 repeated attribute ranges } },
//   2 style padding EdgeInsets, 3 layout margins, 4 bplist resolvable attribute configuration (timer source),
//   5 TextLayoutProperties, 6 content transitions, 7 features bitset, 8 the next size variant (same message) }
function decodeTextBody(body: Msg | undefined, size: { w: number; h: number } | undefined): TextContent {
  const runs = body?.msgs(1) ?? [];
  const text = runs.map((r) => new TextDecoder().decode(r.bytesOf(1) ?? new Uint8Array())).join('');
  // each run repeats field 2: attribute ranges { 1 utf16 location, 2 utf16 length, 3 {1 font chunk}, 4 colour, ... }
  const cp: number[] = []; // utf16 offset -> code point index
  let ci = 0;
  for (const ch of text) {
    for (let u = 0; u < ch.length; u++) cp.push(ci);
    ci++;
  }
  cp.push(ci);
  const spans: TextSpan[] = [];
  let base = 0;
  let paraStyle: ParagraphStyle | undefined;
  for (const r of runs) {
    const runLen = new TextDecoder().decode(r.bytesOf(1) ?? new Uint8Array()).length;
    const ranges = r.msgs(2);
    for (const a of ranges) {
      const lo = base + a.int(1);
      const hi = Math.min(base + runLen, lo + a.int(2, runLen));
      const col = a.msg(4);
      const font = a.msg(3);
      // an empty colour means the environment's foreground (primary label) colour, resolved at render time
      const span: TextSpan = { start: cp[lo] ?? 0, length: (cp[hi] ?? ci) - (cp[lo] ?? 0), fontChunk: font?.int(1, -1), color: col?.fields.length ? resolvedColor(col) : undefined };
      // 8 and 9: kerning and tracking in points, added after every character (Citrix's 16 pt "Citrix Workspace" with
      // 0.8 measures 120.9 pt shaped plus 16 x 0.8 = 133.7, laid out as 134)
      const spacing = (a.has(8) ? a.float(8) : 0) + (a.has(9) ? a.float(9) : 0);
      if (spacing) span.spacing = spacing;
      // 14: text shadow (ShadowStyle { 1 colour, 2 radius, 3 offset })
      const sh = a.msg(14);
      if (sh) {
        const off = sh.msg(3);
        span.shadow = { color: resolvedColor(sh.msg(1)), radius: sh.float(2), dx: off?.float(1) ?? 0, dy: off?.float(2) ?? 0 };
        sh.ignore(4, 5);
        checkUnread(off, 'ShadowOffset');
        checkUnread(sh, 'TextShadow');
      }
      spans.push(span);
      const ps = decodeParagraphStyle(a.msg(5));
      paraStyle ??= ps;
      checkUnread(font, 'ChunkRef');
      // 35 (format) is read from the first range below; 34 lists the format's per-range attributes, which we style
      // from the ranges themselves
      // 15: the range's language tag, which does not change how we draw; 18/20 are read from the first range below
      a.ignore(34, 35, 15, 18, 20);
      checkUnread(a, 'TextAttributes');
    }
    checkUnread(r, 'TextRun');
    base += runLen;
  }
  const attrs = runs[0]?.msgs(2)[0];
  const col = attrs?.msg(4);
  const format = plistAt(attrs?.bytesOf(35));
  const fmt = format?.value?.format;
  // 20 {wallClock, alignment} marks live time-of-day text; 18 holds its format {dateFormat {template}, timeZone, locale}
  const wall = plistAt(attrs?.bytesOf(20));
  const dateFmt = plistAt(attrs?.bytesOf(18));
  const template = dateFmt?.dateFormat?.template?._0;
  const clock: WallClock | undefined =
    wall?.wallClock && typeof template === 'string' ? { template, timeZone: dateFmt?.timeZone?.identifier, locale: dateFmt?.locale?.identifier } : undefined;
  // TextLayoutProperties { 2 line limit (zigzag), 3 lower line limit (zigzag, reserves space), 4 minimum scale factor,
  //   5 line spacing, 6 line height multiple, 7 maximum line height, 8 minimum line height, 9 hyphenation factor,
  //   11 pixel length, 12 multiline alignment (1 leading, 2 center, 3 trailing), 14 content transition style }
  const para = body?.msg(5);
  // 11: pixel length, 1/display scale (0.333 on iPhone, 0.5 on a retina Mac), for pixel rounding we do not do
  // 14: ContentTransition.Style {1 sessionWidget | 2 animatedWidget}, how changes animate
  // 3: lower line limit; the frame already reserves the lines, which the line slots below follow
  para?.ignore(11, 14, 3);
  const zz = (v: number) => (v % 2 ? -(v + 1) / 2 : v / 2);
  const lineLimit = para?.has(2) ? zz(para.int(2)) : undefined;
  const minScale = para?.has(4) ? para.float(4) : undefined;
  const fmtAlign = fmt?.textAlignment?.value;
  // 12 is read below unless a format's own alignment (timers) decides; both agree where both exist
  para?.ignore(12);
  const align: TextAlign =
    typeof fmtAlign === 'number'
      ? ((['start', 'middle', 'end'] as const)[fmtAlign] ?? 'start')
      : para?.has(12)
        ? ((['start', 'start', 'middle', 'end'] as const)[para.int(12)] ?? 'start')
        : (paraStyle?.align ?? 'start');
  // 2: style padding, the room text decorations such as shadows need around the text; the frame includes it
  const pad = body?.msg(2);
  const padding = pad ? ([pad.float(1), pad.float(2), pad.float(3), pad.float(4)] as [number, number, number, number]) : undefined;
  checkUnread(pad, 'EdgeInsets');
  // 6 per-text content transitions (also carried by the enclosing effect), 7 features bitset (key colour, sensitive,
  // unique size variant...): neither changes the drawing
  body?.ignore(6, 7);
  const out: TextContent = {
    kind: 'text',
    lineLimit: lineLimit && lineLimit > 0 ? lineLimit : undefined,
    minScale: minScale !== undefined && minScale > 0 && minScale < 1 ? minScale : undefined,
    clock,
    text,
    color: col?.fields.length ? resolvedColor(col) : undefined,
    size,
    fontChunk: attrs?.msg(3)?.int(1, -1),
    align,
    tabular: !!fmt?.monospacedDigits,
    timer: decodeTimer(plistAt(body?.bytesOf(4)), format),
    spans,
  };
  if (paraStyle?.justified && !para?.has(12)) out.justify = true;
  const lineSpacing = para?.has(5) ? para.float(5) : paraStyle?.lineSpacing;
  if (lineSpacing) out.lineSpacing = lineSpacing;
  const mult = para?.has(6) ? para.float(6) : paraStyle?.lineHeightMultiple;
  if (mult && mult > 0) out.lineHeightMultiple = mult;
  const maxLH = para?.has(7) ? para.float(7) : paraStyle?.maxLineHeight;
  if (maxLH && maxLH > 0) out.maxLineHeight = maxLH;
  const minLH = para?.has(8) ? para.float(8) : paraStyle?.minLineHeight;
  if (minLH && minLH > 0) out.minLineHeight = minLH;
  // 9: hyphenation factor (the paragraph style's 8 repeats it)
  const hyph = para?.has(9) ? para.float(9) : paraStyle?.hyphenation;
  if (hyph && hyph > 0) out.hyphenation = hyph;
  if (padding && padding.some((v) => v)) out.padding = padding;
  // 8: the next size variant (Text with several sizes, e.g. "Wednesday" / "Wed"); the system shows the first that fits
  if (body?.has(8)) {
    const v = decodeTextBody(body.msg(8), size);
    out.variants = [v, ...(v.variants ?? [])];
    delete v.variants;
  }
  checkUnread(para, 'TextParagraph');
  checkUnread(body, 'TextBody');
  return out;
}

type ParagraphStyle = { align?: TextAlign; justified?: boolean; lineSpacing?: number; lineHeightMultiple?: number; maxLineHeight?: number; minLineHeight?: number; hyphenation?: number };

// NSParagraphStyle per attribute range { 1 alignment (CTTextAlignment: 0 left, 1 right, 2 center, 3 justified,
//   4 natural), 2 line break mode, 4 line spacing, 5 line height multiple, 6 maximum line height, 7 minimum line
//   height, 8 hyphenation factor, 9/10/12 flags }. The layout properties repeat most of it and win when present.
function decodeParagraphStyle(m: Msg | undefined): ParagraphStyle | undefined {
  if (!m) return undefined;
  const a = m.has(1) ? m.int(1) : 4;
  const out: ParagraphStyle = { align: a === 1 ? 'end' : a === 2 ? 'middle' : 'start', justified: a === 3 };
  if (m.has(4)) out.lineSpacing = m.float(4);
  if (m.has(5)) out.lineHeightMultiple = m.float(5);
  if (m.has(6)) out.maxLineHeight = m.float(6);
  if (m.has(7)) out.minLineHeight = m.float(7);
  if (m.has(8)) out.hyphenation = m.float(8);
  // 2 line break mode: placeholders say character wrapping (1), which the placeholder bars already do; text
  // truncation follows the layout properties.
  // 9, 10 and 12 are small flags (base writing direction 0 = left to right; 9 and 12 are always 1 when present,
  // likely tightening for truncation and the line break strategy) that do not move glyphs in left-to-right text
  // 3: line break strategy bits (65534 seen: the standard strategy without one bit), which only nudges where
  // lines break
  m.ignore(2, 3, 9, 10, 12);
  checkUnread(m, 'ParagraphStyle');
  return out;
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
// CoreText resolves the condensed text styles (UICTFontTextStyleCondensed*) to the system font's
// SemiCondensed instances, wdth 80
const TEXT_STYLE_CONDENSED_WIDTH = 80;

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
  // traits { 2 NSFontWeight (-1..1), 5 design such as NSCTFontUIFontDesignRounded }
  const traits = m.msg(8);
  const design = traits?.str(5) ?? '';
  let weight = Number(vars?.[String(0x77676874)]);
  if (!weight && traits?.has(2)) weight = fontWeightToWght(traits.float(2));
  if (!weight) {
    const n = name.toLowerCase();
    // the system font's own wght values for its named weights (CoreText resolves Demi/Semibold to 590;
    // emphasized text styles are the semibold variant)
    const table: [string, number][] = [['ultralight', 100], ['thin', 200], ['light', 300], ['medium', 510], ['semibold', 590], ['demi', 590], ['heavy', 860], ['black', 1000], ['bold', 700], ['emphasized', 590]];
    weight = table.find(([k]) => n.includes(k))?.[1] ?? 400;
  }
  // 4: symbolic traits bitmask, subsumed by the weight and design we read
  // 6: dynamic type size of a text style (3 = large, the default) and 16: the platform whose text style table
  //    resolved it (3 on macOS-rendered widgets, 0 on iOS); both are already folded into the size (7) and weight.
  // 13: language tag the font was matched for
  m.ignore(4, 6, 13, 16);
  // traits 3: width trait (Font.Width: compressed -0.3, condensed -0.2, standard 0, expanded 0.2)
  const widthTrait = traits?.has(3) ? traits.float(3) : undefined;
  // 2: { 1 file url } of a font the app registered itself
  const urlMsg = m.msg(2);
  const url = urlMsg?.str(1);
  checkUnread(urlMsg, 'FontURL');
  checkUnread(traits, 'FontTraits');
  checkUnread(m, 'FontDescriptor');
  return {
    name,
    ps: m.str(3),
    size,
    weight,
    width: widthTrait ? widthTraitToWdth(widthTrait) : /condensed/i.test(name) ? TEXT_STYLE_CONDENSED_WIDTH : undefined,
    ...(url ? { url } : {}),
    rounded: /rounded/i.test(name) || /rounded/i.test(design),
    // feature type 6 selector 0 is monospaced numbers
    monospacedDigits: feats.some((f) => f?.CTFeatureTypeIdentifier === 6 && f?.CTFeatureSelectorIdentifier === 0),
    // AAT feature (type, selector) -> opentype: 6/0 tnum, 37/1 lower case small caps, 38/1 upper case small caps
    features: feats.flatMap((f) => {
      const t = f?.CTFeatureTypeIdentifier;
      const v = f?.CTFeatureSelectorIdentifier;
      // 35 stylistic alternatives: selector 2n turns set n on (ssNN), e.g. Focus Friend's 35/6 = ss03
      if (t === 35 && typeof v === 'number' && v > 0 && v % 2 === 0 && v <= 40) return [`ss${String(v / 2).padStart(2, '0')}`];
      return t === 6 && v === 0 ? ['tnum'] : t === 37 && v === 1 ? ['smcp'] : t === 38 && v === 1 ? ['c2sc'] : [];
    }),
  };
}

// width trait to the system font's wdth axis: Font.Width's named values (compressed -0.3, condensed -0.2,
// expanded 0.2) sit on SF's Compressed (47), Condensed (60) and Expanded (132) instances, linear between them
// (so 0.1 lands on SemiExpanded, 116, and -0.1 on SemiCondensed, 80)
function widthTraitToWdth(t: number): number {
  const stops: [number, number][] = [[-0.5, 30], [-0.4, 38], [-0.3, 47], [-0.2, 60], [0, 100], [0.2, 132], [0.4, 150]];
  if (t <= stops[0]![0]) return stops[0]![1];
  for (let i = 1; i < stops.length; i++) {
    const [a, wa] = stops[i - 1]!;
    const [b, wb] = stops[i]!;
    if (t <= b) return wa + ((t - a) * (wb - wa)) / (b - a);
  }
  return 150;
}

// NSFontWeight constants to the system font's wght axis, linear between the named stops
function fontWeightToWght(w: number): number {
  const stops: [number, number][] = [[-0.8, 100], [-0.6, 200], [-0.4, 300], [0, 400], [0.23, 510], [0.3, 590], [0.4, 700], [0.56, 860], [0.62, 1000]];
  if (w <= stops[0]![0]) return stops[0]![1];
  for (let i = 1; i < stops.length; i++) {
    const [a, wa] = stops[i - 1]!;
    const [b, wb] = stops[i]!;
    if (w <= b) return Math.round(wa + ((w - a) * (wb - wa)) / (b - a));
  }
  return 1000;
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
  checkUnread(px, 'ImagePixelSize');
  if (m.has(1)) img.source = { kind: 'color', color: resolvedColor(m.msg(1)) };
  else if (m.has(2)) {
    const ref = m.msg(2)!;
    img.source = { kind: 'bitmap', chunk: ref.int(1, -1) };
    checkUnread(ref, 'ChunkRef');
  } else if (m.has(3)) {
    const v = m.msg(3)!;
    const sz = v.msg(2);
    const ref = v.msg(1);
    img.source = { kind: 'vector', chunk: ref?.int(1, -1) ?? -1, size: { w: sz?.float(1) ?? 0, h: sz?.float(2) ?? 0 } };
    checkUnread(ref, 'ChunkRef');
    checkUnread(sz, 'Size');
    checkUnread(v, 'VectorImage');
  }
  if (m.has(8)) img.tint = resolvedColor(m.msg(8));
  // 7 orientation (Image.Orientation, up = 0 is the default and never written)
  if (m.has(7)) img.orientation = m.int(7);
  // 9 resizing info { 1 mode (0 stretch, 1 tile), 2 cap insets EdgeInsets {1 top, 2 leading, 3 bottom, 4 trailing} }
  const rz = m.msg(9);
  if (rz) {
    const ci = rz.msg(2);
    img.resizing = { tile: rz.int(1) === 1, caps: [ci?.float(1) ?? 0, ci?.float(2) ?? 0, ci?.float(3) ?? 0, ci?.float(4) ?? 0] };
    checkUnread(ci, 'EdgeInsets');
    checkUnread(rz, 'ImageResizing');
  }
  // 11 interpolation (0 none, 1 low = default, 2 medium, 3 high)
  if (m.has(11)) img.interpolation = m.int(11);
  // 10 isAntialiased (default true): edge antialiasing of the transformed bitmap, a sub-pixel matter in svg
  // 12 allowed dynamic range (0 standard): hdr headroom, nothing to do for an sdr target
  m.ignore(10, 12);
  return img;
}

// swiftui Path: 1 rect, 2 ellipse, 3 rounded rect, 4 renderbox path data
export function decodePath(m: Msg | undefined): Shape {
  if (!m) return { parts: [] };
  let out: Shape = { parts: [] };
  if (m.has(1)) {
    const r = rect(m.msg(1));
    out = { parts: [{ d: rectD(r) }], bounds: r };
  } else if (m.has(2)) {
    const r = rect(m.msg(2));
    out = { parts: [{ d: ellipseD(r) }], bounds: r };
  } else if (m.has(3)) {
    const rr = m.msg(3)!;
    const r = rect(rr.msg(1));
    const cs = rr.msg(2);
    out = { parts: [{ d: rrectD(r, cs?.float(1) ?? 0, cs?.float(2) ?? 0, rr.int(3) === 1) }], bounds: r };
    checkUnread(cs, 'Size');
    checkUnread(rr, 'RoundedRect');
  } else if (m.has(4)) {
    const d = m.msg(4)!;
    const { parts, badOp } = rbPath(d);
    out = { parts, badOp };
    checkUnread(d, 'PathData');
  }
  checkUnread(m, 'Path');
  return out;
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
  const stops = (g?.msgs(1) ?? []).map((s) => {
    const st = { color: resolvedColor(s.msg(1)), at: s.float(2) };
    checkUnread(s, 'GradientStop');
    return st;
  });
  // 2: interpolation colour space; stops are drawn in srgb. 3: HDR headroom (always 1, standard range)
  g?.ignore(2, 3);
  checkUnread(g, 'Gradient');
  return stops;
}

function decodePaint(m: Msg | undefined): Paint {
  const f = m?.first();
  if (!m || !f) return { kind: 'color', color: [0, 0, 0, 1] };
  const p = Msg.from(f);
  let out: Paint;
  switch (f.no) {
    case 1:
      out = { kind: 'color', color: resolvedColor(p) };
      break;
    case 2:
      out = { kind: 'linear', stops: decodeStops(p.msg(1)), from: pt(p.msg(2)), to: pt(p.msg(3)), units: 'unit' };
      break;
    case 10:
      out = { kind: 'linear', stops: decodeStops(p.msg(1)), from: pt(p.msg(2)), to: pt(p.msg(3)), units: 'abs' };
      break;
    case 3:
      out = { kind: 'radial', stops: decodeStops(p.msg(1)), center: pt(p.msg(2)), r0: p.float(3), r1: p.float(4) };
      break;
    case 4:
      out = { kind: 'angular', stops: decodeStops(p.msg(1)), center: pt(p.msg(2)), start: p.float(3), end: p.float(4, Math.PI * 2) };
      break;
    default:
      unknown(`paint-field:${f.no}`, preview(f));
      return { kind: 'unknown', field: f.no };
  }
  // 7: anchor rect, the rect a unit-space paint is laid out in when it is not the shape's own frame
  const anchor = m.msg(7);
  if (anchor && (out.kind === 'linear' || out.kind === 'radial' || out.kind === 'angular')) out.anchor = rect(anchor);
  else m.ignore(7);
  checkUnread(m, 'PaintValue');
  if (f.no !== 1) checkUnread(p, `Paint.${out.kind}`);
  return out;
}

// effect fields we recognise but that change nothing we draw
const QUIET_EFFECTS: Record<number, string> = {
  1: 'empty group (an identity or geometry group: nothing but grouping)',
  2: 'empty group',
  10: 'properties bitset',
  20: 'state hash of the subtree (interaction/animation bookkeeping)',
  25: 'accessibility representation (an alternative list that is never drawn)',
};

function decodeEffect(m: Msg | undefined): Effect {
  const f = m?.first();
  if (!m || !f) return { kind: 'passthrough', field: 0 };
  checkUnread(m, 'EffectValue');
  const e = Msg.from(f);
  const out = effectCase(f.no, m, e);
  if (out.kind === 'passthrough') {
    if (!QUIET_EFFECTS[f.no]) unknown(`effect-field:${f.no}`, preview(f));
  } else if (out.kind !== 'accessibility' && out.kind !== 'filter' && out.kind !== 'transition') checkUnread(e, `Effect.${out.kind}`);
  return out;
}

function effectCase(no: number, m: Msg, e: Msg): Effect {
  switch (no) {
    case 3:
      return { kind: 'opacity', value: m.float(3, 1) };
    case 4:
      return { kind: 'blend', mode: e.int(1) ?? 0 };
    case 5: {
      const fs = e.msg(2);
      const shape = { ...decodePath(e.msg(1)), eo: fs?.bool(1) ?? false };
      // FillStyle 2: antialiasing, always on in svg
      fs?.ignore(2);
      checkUnread(fs, 'FillStyle');
      return { kind: 'clip', shape };
    }
    case 6:
      return { kind: 'mask', children: decodeList(e.msg(1)) };
    case 7:
      return { kind: 'transform', m: affine(e) };
    case 9:
      return { kind: 'filter', filters: [decodeFilter(e)] };
    case 12: {
      const ref = e.msg(2);
      const out: Effect = { kind: 'group', name: e.str(1), chunk: ref?.has(1) ? ref.int(1) : undefined };
      checkUnread(ref, 'ChunkRef');
      return out;
    }
    case 14:
      return accessibility(e);
    case 16:
      return { kind: 'transition', transition: decodeTransition(e) };
    case 21: {
      // rotation: angle (radians) about an anchor point in local space
      const a = e.float(1) ?? 0;
      const c = pt(e.msg(2));
      const [cos, sin] = [Math.cos(a), Math.sin(a)];
      return { kind: 'transform', m: [cos, sin, -sin, cos, c.x - cos * c.x + sin * c.y, c.y - sin * c.x - cos * c.y] };
    }
    case 22: {
      // rotation3d flattened to the affine it projects to without perspective (7 anchor z, 8 perspective dropped)
      const a = e.float(1) ?? 0;
      const [ax, ay] = [e.float(2) ?? 0, e.float(3) ?? 0];
      const [cx, cy] = [e.float(5) ?? 0, e.float(6) ?? 0];
      const len = Math.hypot(ax, ay, e.float(4) ?? 0) || 1;
      e.ignore(7, 8);
      const sx = 1 - (1 - Math.cos(a)) * (ay / len) ** 2;
      const sy = 1 - (1 - Math.cos(a)) * (ax / len) ** 2;
      return { kind: 'transform', m: [sx, 0, 0, sy, cx - sx * cx, cy - sy * cy] };
    }
    default:
      return { kind: 'passthrough', field: no };
  }
}

// State { 1 ContentTransition { 1 named, 2 custom {1 method, repeated 2 effect}, 3 replaceable }, 2 style, 3 animation,
// 4 options }. named: one field per name plus 8 style; numericText { 1 downwards, 2 automatic value, 3 ? }
function decodeTransition(e: Msg): Transition {
  const t = e.msg(1);
  const styleOf = (m: Msg | undefined) => (m?.has(1) ? 'sessionWidget' : m?.has(2) ? 'animatedWidget' : undefined);
  const named = t?.msg(1);
  const outer = e.msg(2);
  const style = styleOf(named?.msg(8) ?? outer);
  // 3 animation and 4 options: how the device animates, which the webapp decides itself
  e.ignore(3, 4);
  // 4: symbol replace configuration (SF Symbol replace animation)
  t?.ignore(2, 3, 4);
  checkUnread(e, 'TransitionState');
  checkUnread(t, 'ContentTransition');
  if (!named) return { kind: t?.has(2) ? 'custom' : 'unknown', style };
  const f = named.fields.find((x) => x.no !== 8);
  const kinds: Transition['kind'][] = ['unknown', 'default', 'identity', 'opacity', 'interpolate', 'text', 'numericText'];
  const out: Transition = { kind: (f && kinds[f.no]) || (f ? 'unknown' : 'default'), style };
  if (f) named.ignore(f.no);
  if (f && !kinds[f.no]) unknown(`transition-field:${f.no}`, preview(f));
  checkUnread(named, 'NamedTransition');
  if (f?.no === 6) {
    const n = Msg.from(f);
    if (n.has(1)) out.countsDown = n.int(1) === 1;
    if (n.has(2)) out.value = n.float(2);
    // 3 and 4: NumericTextConfiguration options (animation behaviour only)
    n.ignore(3, 4);
    checkUnread(n, 'NumericTextConfig');
  }
  return out;
}

function decodeFilter(m: Msg): Filter {
  const f = m.first();
  if (!f) return { kind: 'unknown', field: 0 };
  checkUnread(m, 'FilterValue');
  const p = Msg.from(f);
  const out = filterCase(f.no, m, p);
  if (out.kind === 'unknown') unknown(`filter-field:${f.no}`, preview(f));
  else checkUnread(p, `Filter.${out.kind}`);
  return out;
}

function filterCase(no: number, m: Msg, p: Msg): Filter {
  switch (no) {
    case 1:
      // 2 opaque and 3 dither flags of a material blur: edge handling, not colour
      p.ignore(2, 3);
      return { kind: 'blur', radius: p.float(1) ?? 0 };
    case 15: {
      // material tone curve: 1 packed f32 values at evenly spaced inputs, 2 amount mixed with the identity
      const values = f32s(p.bytesOf(1)) ?? [];
      return { kind: 'curve', values, amount: p.float(2, 1) };
    }
    case 2: {
      const off = p.msg(3);
      const k = p.int(4);
      const out: Filter = { kind: 'shadow', color: resolvedColor(p.msg(1)), radius: p.float(2) ?? 0, dx: off?.float(1) ?? 0, dy: off?.float(2) ?? 0 };
      if (k & 1) out.inner = true;
      if (k & 2) out.only = true;
      // 5: midpoint of the shadow's falloff (0.5 default), which a gaussian blur already has
      p.ignore(5);
      checkUnread(off, 'ShadowOffset');
      return out;
    }
    case 4: {
      const id = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
      return { kind: 'matrix', m: id.map((v, i) => p.float(i + 1, v) ?? v) };
    }
    case 14: {
      // rgb-only 3x5 matrix, alpha row untouched
      const id = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0];
      return { kind: 'matrix', m: [...id.map((v, i) => p.float(i + 1, v) ?? v), 0, 0, 0, 1, 0] };
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
      return { kind: 'unknown', field: no };
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
  checkUnread(extra, 'PathExtras');
  for (const st of styles) st.ignore(1, 2, 3);
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
export type RBClip = ({ shape: RBShape; m: Affine } | { mask: RBList }) & { invert?: boolean };
export type RBResource = { id: number; font?: RBFont; clip?: RBClip[]; image?: number /* chunk */ };
export type RBList = { entries: RBEntry[]; resources: Map<number, RBResource> };
export type RBShape =
  | { kind: 'path'; parts: PathPart[]; eo?: boolean; badOp?: number }
  | { kind: 'glyphs'; font: number; glyphs: { gid: number; x: number }[]; placeholder?: boolean }
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
    const fontRes = r.msg(3);
    const fr = fontRes?.msg(1);
    if (fr?.has(3)) res.font = { kind: 'embedded', chunk: fr.msg(3)!.int(1, -1) };
    else if (fr?.has(4)) res.font = { kind: 'system', chunk: fr.msg(4)!.int(1, -1) };
    if (r.has(2)) res.image = r.msg(2)?.msg(1)?.msg(1)?.int(1, -1);
    if (r.has(4)) {
      // clip list { repeated 1 { 1 { 1 shape, 2 transform } or 2 { 1 display list drawn as an alpha mask },
      //   4 inverted (keep what lies outside), 5 identity link } }
      const cl = r.msg(4)!;
      res.clip = cl.msgs(1).map((c): RBClip => {
        const s = c.msg(1);
        const mask = c.msg(2);
        const out: RBClip = mask
          ? { mask: decodeRBList(mask.msg(1) ?? Msg.from(undefined), resources), invert: c.int(4) === 1 }
          : { shape: decodeRBShape(s?.msg(1)), m: affine(s?.msg(2)), invert: c.int(4) === 1 };
        checkUnread(mask, 'RBClipMask');
        c.ignore(5);
        checkUnread(s, 'RBClipShape');
        checkUnread(c, 'RBClipEntry');
        return out;
      });
      checkUnread(cl, 'RBClipList');
    }
    // 8: filter/animation resources referenced by entry field 7, which we do not apply
    r.ignore(8);
    checkUnread(fr, 'RBFontRef');
    checkUnread(fontRes, 'RBFontResource');
    checkUnread(r, 'RBResource');
    resources.set(id, res);
  }
  // 4: archive type uuid
  m.ignore(4);
  const list = m.msg(1);
  const out = decodeRBList(list ?? Msg.from(undefined), resources);
  checkUnread(m, 'RBChunk');
  return out;
}

function decodeRBList(m: Msg, resources: Map<number, RBResource>): RBList {
  const out = { entries: m.msgs(1).map((e) => decodeRBEntry(e, resources)), resources };
  checkUnread(m, 'RBList');
  return out;
}

function decodeRBEntry(m: Msg, resources: Map<number, RBResource>): RBEntry {
  const e: RBEntry = {};
  const it = m.msg(1);
  if (it) {
    e.item = { shape: decodeRBShape(it.msg(1)), paint: decodeRBPaint(it.msg(2)), m: affine(it.msg(3)) };
    checkUnread(it, 'RBItem');
  }
  if (m.has(2)) {
    const g = m.msg(2)!;
    e.group = decodeRBList(g.msg(1) ?? Msg.from(undefined), resources);
    checkUnread(g, 'RBGroup');
  }
  if (m.has(4)) e.alpha = m.float(4, 1);
  if (m.has(5)) e.blend = m.int(5);
  if (m.has(6)) {
    const c = m.msg(6)!;
    e.clip = c.int(1);
    checkUnread(c, 'RBClipRef');
  }
  // 7: identity/animation link to resource field 8, which we do not apply
  m.ignore(7);
  checkUnread(m, 'RBEntry');
  return e;
}

function decodeRBShape(m: Msg | undefined): RBShape {
  const f = m?.first();
  if (!m || !f) return { kind: 'unknown', field: 0 };
  checkUnread(m, 'RBShapeValue');
  const s = Msg.from(f);
  const out = rbShapeCase(f.no, s);
  if (out.kind === 'unknown') unknown(`rb-shape-field:${f.no}`, preview(f));
  else checkUnread(s, `RBShape.${f.no === 1 ? 'rect' : f.no === 2 ? 'path' : f.no === 3 ? 'stroke' : out.kind}`);
  return out;
}

function rbShapeCase(no: number, s: Msg): RBShape {
  switch (no) {
    case 1: {
      // rect primitive: 1 corner style, 2 rect, 3 radius, 6 stroke width; no rect means unbounded
      s.ignore(1);
      if (!s.has(2)) return { kind: 'fill' };
      const r = rect(s.msg(2));
      const rad = s.float(3);
      const d = rad ? rrectD(r, rad, rad, s.int(1) === 4) : rectD(r);
      const w = s.float(6);
      return { kind: 'path', parts: [w ? { d, stroke: { width: w, cap: 'butt', join: 'miter', miter: 10 } } : { d }] };
    }
    case 2: {
      const data = s.msg(1);
      const { parts, badOp } = rbPath(data ?? Msg.from(undefined), s.has(2) ? affine(s.msg(2)) : undefined);
      checkUnread(data, 'PathData');
      return { kind: 'path', parts, eo: s.int(3) === 1, badOp };
    }
    case 3: {
      // stroked path: 1 path data, 2 transform, 3 width, 4 cap, 5 join, 6 packed f32 dashes, 7 miter limit
      const stroke: StrokeStyle = { width: s.float(3, 1), cap: CAPS[s.int(4)] ?? 'butt', join: JOINS[s.int(5)] ?? 'miter', miter: s.float(7, 10) };
      const dash = f32s(s.bytesOf(6));
      if (dash) stroke.dash = dash;
      const data = s.msg(1);
      const { parts, badOp } = rbPath(data ?? Msg.from(undefined), s.has(2) ? affine(s.msg(2)) : undefined);
      checkUnread(data, 'PathData');
      return { kind: 'path', parts: parts.map((p) => ({ ...p, stroke: p.stroke ?? stroke })), badOp };
    }
    case 5: {
      const font = s.msg(1);
      const glyphs = s.msgs(2).map((g) => {
        const out = { gid: g.int(1), x: g.float(2) };
        checkUnread(g, 'RBGlyph');
        return out;
      });
      // 3 run flags (rendering hints). 4 = 1 marks a redaction placeholder run: every glyph is a segment of the
      // placeholder bar (U+100BB7), across the corpus without exception. 7 {1, 2}: font smoothing dilation in em,
      // only on runs drawn by macOS (flags bit 1024), irrelevant to outlines
      s.ignore(3, 7);
      const out: RBShape = { kind: 'glyphs', font: font?.int(1) ?? 0, glyphs };
      if (s.int(4) === 1) out.placeholder = true;
      checkUnread(font, 'RBGlyphFont');
      return out;
    }
    default:
      return { kind: 'unknown', field: no };
  }
}

function f16Color(raw: Uint8Array | undefined): RGBA {
  if (!raw || raw.length < 8) return [0, 0, 0, 1];
  const dv = new DataView(raw.buffer, raw.byteOffset, 8);
  return [0, 1, 2, 3].map((k) => f16(dv.getUint16(2 * k, true))) as RGBA;
}

function decodeRBPaint(m: Msg | undefined): RBPaint {
  const f = m?.first();
  if (!m || !f) return { kind: 'color', color: [0, 0, 0, 1] };
  checkUnread(m, 'RBPaintValue');
  const p = Msg.from(f);
  let out: RBPaint;
  switch (f.no) {
    case 1: {
      const c = f16Color(p.get(1)?.raw);
      // 3: HDR headroom, always 1 (standard range) so far
      p.ignore(3);
      // colour space 2 is extended linear
      out = { kind: 'color', color: p.int(2) === 2 ? [lin2srgb(c[0]), lin2srgb(c[1]), lin2srgb(c[2]), c[3]] : c };
      break;
    }
    case 2: {
      // 6: colour space of the stop colours, 2 = extended linear as for colour paints
      let stops = decodeStops(undefined, { colors: p.bytesOf(1), locs: p.bytesOf(2) });
      if (p.int(6) === 2) stops = stops.map((st) => ({ ...st, color: [lin2srgb(st.color[0]), lin2srgb(st.color[1]), lin2srgb(st.color[2]), st.color[3]] as RGBA }));
      out = { kind: 'linear', stops, from: pt(p.msg(7)), to: pt(p.msg(8)) };
      break;
    }
    case 3: {
      const c = p.msg(4);
      const res = p.msg(1);
      out = { kind: 'image', resource: res?.int(1) ?? 0, m: affine(p.msg(3)), color: c ? f16Color(c.get(1)?.raw) : undefined };
      checkUnread(res, 'RBResourceRef');
      // tint 3: HDR headroom, always 1
      c?.ignore(3);
      checkUnread(c, 'RBImageTint');
      break;
    }
    default:
      unknown(`rb-paint-field:${f.no}`, preview(f));
      return { kind: 'unknown', field: f.no };
  }
  checkUnread(p, `RBPaint.${out.kind}`);
  return out;
}

// type 1 subsets name their glyphs after the original font's glyph ids (gid207); the chunk maps those to the
// ids the drawing uses, which also follow the subset's encoding order (code + 1)
function type1Font(bytes: Uint8Array, name: string, map: Msg[]): Font | undefined {
  const t = parseType1(bytes);
  if (!t) return undefined;
  const orig = new Map(map.map((e) => [e.int(2), e.int(1)]));
  const nameOf = (gid: number) => {
    const o = orig.get(gid);
    return o !== undefined && t.glyphPath(`gid${o}`) !== undefined ? `gid${o}` : t.encoding[gid - 1];
  };
  return {
    name: name || t.name,
    bytes,
    unitsPerEm: t.unitsPerEm,
    numGlyphs: Math.max(t.encoding.length + 1, ...orig.keys()),
    charFor: () => undefined,
    glyphPath: (gid) => {
      const n = nameOf(gid);
      return (n && t.glyphPath(n)) || '';
    },
  };
}
