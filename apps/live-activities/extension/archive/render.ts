// display list -> self-contained svg (viewBox in points)

import type { Font } from './sfnt';
import { buildSubset } from './ttf';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isBplist, parseBplist } from './bplist';
import { summarizeAction, unarchive, type IntentSummary } from './keyed';
import { collecting, unknown, Unknowns, type Unknown } from './proto';
import { mul } from './decode';
import { base64 } from './proto';
import {
  decodeFontDesc,
  decodeProgress,
  decodeState,
  type Progress,
  type Timer,
  type Transition,
  type WallClock,
  type Affine,
  type Archive,
  type Content,
  type Effect,
  type Filter,
  type Img,
  type Node,
  type Paint,
  type PathPart,
  type RBEntry,
  type RBList,
  type RBPaint,
  type Rect,
  type RGBA,
  type StateInfo,
  type Stop,
  type TextContent,
} from './decode';

export type RenderOptions = {
  viewTag?: string;
  colorScheme?: 'dark' | 'light';
  luminanceReduced?: boolean;
  redaction?: number;
  stateIndex?: number; // bypass env matching
  idPrefix?: string;
  now?: number; // unix ms used for the initial value of timers and timed progress views // defaults to a hash of the state so inlined svgs never share ids
};

export type RenderResult = {
  svg: string;
  width: number;
  height: number;
  cornerRadius?: number;
  backgroundTint?: RGBA; // listItemViewMetadata.backgroundTintColor (activityBackgroundTint), srgb 0..1
  textColor?: RGBA; // listItemViewMetadata.textColor (activitySystemActionForegroundColor), srgb 0..1
  texts: string[];
  warnings: string[];
  state: StateInfo;
  controls: Control[];
  unknowns: Unknown[]; // data we could not interpret, most frequent first; codes are stable (see decode.ts)
};

// an interactive control as archived: where it is (svg units) and what it would do. nothing here is executed
export type Control = {
  rect: { x: number; y: number; w: number; h: number };
  kind: 'button' | 'toggle' | 'link';
  modifier: string; // archived modifier type, e.g. SwiftUI.ArchivableToggleAppIntentModifier
  isOn?: boolean;
  toggleValue?: number; // raw toggleState.value (0 on, 1 off as seen so far)
  isEnabled?: boolean;
  url?: string; // link modifiers
  action?: { raw: string; decoded?: IntentSummary }; // raw: base64 LNAction keyed archive
};

export function pickState(a: Archive, opts: RenderOptions = {}): StateInfo | undefined {
  if (opts.stateIndex !== undefined) return a.states[opts.stateIndex];
  const tag = opts.viewTag ?? (a.viewTags.includes('listItem') ? 'listItem' : a.viewTags[0]);
  // full colour (rendering mode 0) above everything: accented and vibrant states expect the system to tint them, so
  // a full-colour state in the other colour scheme reads better than an accented one in the asked scheme. then the
  // colour scheme, no redaction, the widget's own background (policy 0) and full luminance
  const want: Record<string, (v: any) => number> = {
    colorScheme: (v) => (v === (opts.colorScheme ?? 'dark') ? 4 : 0),
    isLuminanceReduced: (v) => (v === (opts.luminanceReduced ?? false) ? 1 : 0),
    redactionReasons: (v) => (v === (opts.redaction ?? 0) ? 2 : 0),
    widgetRenderScheme: (v) => ((v?.renderingMode?.mode ?? 0) === 0 ? 16 : 0) + (v?.backgroundViewPolicy === 0 ? 1.5 : 0),
  };
  let best: StateInfo | undefined;
  let bestScore = -1;
  for (const s of a.states) {
    if (s.viewTag !== tag) continue;
    let score = s.entry === 0 ? 100 : 0;
    for (const [k, v] of Object.entries(s.env)) score += want[k]?.(v) ?? 0;
    if (score > bestScore) [best, bestScore] = [s, score];
  }
  return best;
}

export function renderView(a: Archive, opts: RenderOptions = {}): RenderResult | null {
  const found = new Unknowns();
  found.merge(a.unknowns);
  const out = collecting(found, () => render(a, opts));
  if (out) out.unknowns = found.list();
  return out;
}

function render(a: Archive, opts: RenderOptions): RenderResult | null {
  const st = pickState(a, opts);
  if (!st) return null;
  const { size, nodes } = decodeState(a, st);
  if (!nodes.length && !isDisplayList(a.chunk(st.chunk))) return null; // e.g. bitmap snapshot timelines
  const meta = st.metadata as { backgroundTintColor?: number[]; textColor?: number[] } | undefined;
  // the foreground colour text inherits: the activity's own, else the label colour of the state's colour scheme
  // (accented and vibrant states are light on dark, see the background below)
  const accentedState = ((st.env as { widgetRenderScheme?: { renderingMode?: { mode?: number } } }).widgetRenderScheme?.renderingMode?.mode ?? 0) !== 0;
  const textColor = rgba(meta?.textColor) ?? (st.env.colorScheme === 'dark' || accentedState ? LABEL_DARK : LABEL_LIGHT);
  const r = new Renderer(a, opts.idPrefix ?? `v${fnv(a.chunk(st.chunk)).toString(36)}`, opts.now ?? Date.now(), textColor);
  // the host draws the container background when the widget has no background layer (WidgetContentLayerTag
  // contentLayer 1) or the state has it removed (backgroundViewPolicy != 0). accented and vibrant states (rendering
  // mode 1 and 2) resolve their content to light-on-dark whatever the colour scheme (Books' light accented state is
  // white text on a 16% white layer), so the host backing is dark there
  const scheme = (st.env as { widgetRenderScheme?: { renderingMode?: { mode?: number }; backgroundViewPolicy?: number } }).widgetRenderScheme;
  const mode = scheme?.renderingMode?.mode ?? 0;
  const policy = scheme?.backgroundViewPolicy ?? 0;
  r.renderingMode = mode;
  let bgRect = '';
  if (a.kind === 'widget' && (mode !== 0 || policy !== 0 || !hasBackgroundLayer(a, nodes))) {
    const bg = mode !== 0 || st.env.colorScheme === 'dark' ? WIDGET_BACKGROUND_DARK : WIDGET_BACKGROUND_LIGHT;
    bgRect = `<rect width="${num(size.w || st.size.w)}" height="${num(size.h || st.size.h)}" ${colorAttrs(bg)}/>`;
  }
  // backdrops (materials) blur what lies behind them, which starts with that background
  const body = bgRect + r.withBehind(bgRect, () => r.nodes(nodes));
  const w = size.w || st.size.w;
  const h = size.h || st.size.h;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(w)} ${num(h)}" width="${num(w)}" height="${num(h)}">` +
    (r.defs.length ? `<defs>${r.defs.join('')}</defs>` : '') +
    body +
    '</svg>';
  return {
    svg,
    width: w,
    height: h,
    cornerRadius: st.cornerRadius,
    backgroundTint: rgba(meta?.backgroundTintColor),
    textColor: rgba(meta?.textColor),
    texts: r.texts.length ? r.texts : r.labels,
    warnings: [...r.warnings],
    controls: r.controls,
    unknowns: [],
    state: st,
  };
}

const num = (v: number) => String(+v.toFixed(3));
const isDisplayList = (b: Uint8Array) => b[0] === 0x0a;
// archived modifier types and the payload keys we understand; others are reported as unknowns
const KNOWN_MODIFIERS: Record<string, string[]> = {
  'SwiftUI.ArchivableToggleAppIntentModifier': ['toggleState', 'isEnabled'],
  'SwiftUI.ArchivableButtonAppIntentModifier': ['action', 'isEnabled'],
  'SwiftUI.ArchivableLinkModifier': ['configuration'],
  'SwiftUI.ArchivableAccessibilityViewModifier': ['attachment'],
  'WidgetKit.WidgetURLModifier': ['url'],
  'WidgetKit.WidgetContentLayerTag': ['contentLayer'],
  'SwiftUI.InvalidatableContentModifier': ['invalidatable'],
  'WidgetKit.HideViewInCarPlayModifier': [],
  'WidgetKit.HideViewOnSnapshotModifier': [],
  'WidgetKit.WidgetAccentedDesaturatedViewModifier': ['accented'],
  'WidgetKit._ClockHandRotationEffect': ['anchor', 'period', 'timeZone'],
};

function archivedModifierAt(a: Archive, chunk: number): any {
  const b = a.chunk(chunk);
  if (!isBplist(b)) return undefined;
  try {
    const v: any = parseBplist(b);
    return (Array.isArray(v) ? v[0] : v)?.modifier;
  } catch {
    return undefined;
  }
}

// the most recent local midnight (unix ms) in an iana time zone; the system zone when none or unknown
function localMidnight(now: number, zone?: string): number {
  let offset = -new Date(now).getTimezoneOffset() * 60000;
  if (zone) {
    try {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
          .formatToParts(new Date(now))
          .map((p) => [p.type, Number(p.value)]),
      );
      offset = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) - Math.floor(now / 1000) * 1000;
    } catch {}
  }
  return Math.floor((now + offset) / 86400000) * 86400000 - offset;
}

function filterRegion(fs: Filter[], frame?: Rect): string {
  if (!frame) return 'x="-50%" y="-50%" width="200%" height="200%"';
  const reach = fs.reduce((m, f) => Math.max(m, f.kind === 'blur' ? f.radius * 2 : f.kind === 'shadow' ? f.radius * 2 + Math.max(Math.abs(f.dx), Math.abs(f.dy)) : 0), 0);
  const pad = reach + Math.max(frame.w, frame.h) * 0.25 + 4;
  return `filterUnits="userSpaceOnUse" x="${num(-pad)}" y="${num(-pad)}" width="${num(frame.w + 2 * pad)}" height="${num(frame.h + 2 * pad)}"`;
}

const sha1Hex = (b: Uint8Array) => createHash('sha1').update(b).digest('hex');
const int64le = (v: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, BigInt(v), true);
  return b;
};
// sha1 of a single false byte: the "not pressed" state of buttons and links
const PRESSED_FALSE = sha1Hex(new Uint8Array([0]));
const rgba = (v: unknown): RGBA | undefined =>
  Array.isArray(v) && v.length >= 3 && v.every((x) => typeof x === "number") ? [v[0] as number, v[1] as number, v[2] as number, (v[3] as number | undefined) ?? 1] : undefined;

// ios system text metrics (sf pro): ascender and default line height in ems
const IOS_ASCENT = 0.952;
const IOS_LINE_HEIGHT = 1.193;
// the redaction placeholder glyph: single-line placeholder frames across the corpus are exactly 0.5 em
// per character; the bar height is measured from macOS renders of redacted widgets
const REDACTION_ADVANCE_EM = 0.5;
const REDACTION_BAR_EM = 0.66;
// SF's redaction placeholder glyph (U+100BB7, gid 2672 in macOS SFNS): a rounded segment 1000/2048 em wide and
// 1443/2048 em tall standing on the baseline, corners about 294/2048 em; consecutive segments overlap into one bar
const PLACEHOLDER_SEGMENT_EM = 1000 / 2048;
const PLACEHOLDER_BAR_HEIGHT_EM = num(1443 / 2048);
const PLACEHOLDER_BAR_RADIUS_EM = num(294 / 2048);
// ios linear ProgressView: 4pt capsule bar; the track is a system fill, not the tint (measured on device)
const IOS_PROGRESS_THICKNESS = 4;
// placeholder for archived platform views whose content only exists in the host process (their archived state can
// be an empty {view: {}}): ios's translucent tertiary system fill, the colour redacted placeholders use, so the space
// reads as content not loaded over the widget's own background in either colour scheme
const UNAVAILABLE_FILL: RGBA = [118 / 255, 118 / 255, 128 / 255, 0.24];
// characters a ticking timer can show, embedded so the device never falls back mid-count
const TIMER_CHARS = [...'0123456789:-'];
// png and jpeg pass through; heif (iphone photos) is converted with macos's sips when available, cached per content
const converted = new Map<string, Uint8Array | null>();
function webImage(b: Uint8Array): { mime: string; bytes: Uint8Array } | undefined {
  if (b[0] === 0x89 && b[1] === 0x50) return { mime: 'image/png', bytes: b };
  if (b[0] === 0xff && b[1] === 0xd8) return { mime: 'image/jpeg', bytes: b };
  const brand = String.fromCharCode(...b.subarray(4, 12));
  if (!/^ftyp(heic|heix|hevc|mif1|msf1|avif)/.test(brand)) return undefined;
  const key = `${b.length}:${fnv(b)}`;
  if (!converted.has(key)) {
    let png: Uint8Array | null = null;
    try {
      const dir = mkdtempSync(join(tmpdir(), 'la-heif-'));
      try {
        writeFileSync(join(dir, 'in.heic'), b);
        execFileSync('sips', ['-s', 'format', 'png', join(dir, 'in.heic'), '--out', join(dir, 'out.png')], { stdio: 'ignore' });
        png = new Uint8Array(readFileSync(join(dir, 'out.png')));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {}
    converted.set(key, png);
  }
  const png = converted.get(key);
  return png ? { mime: 'image/png', bytes: png } : undefined;
}

// ios systemBackground for widgets that leave the container background to the system
const WIDGET_BACKGROUND_LIGHT: RGBA = [1, 1, 1, 1];
const WIDGET_BACKGROUND_DARK: RGBA = [28 / 255, 28 / 255, 30 / 255, 1];

function hasBackgroundLayer(a: Archive, nodes: Node[]): boolean {
  for (const n of nodes) {
    if (n.effect?.kind === 'group' && n.effect.name === 'WidgetKit.WidgetContentLayerTag' && n.effect.chunk !== undefined) {
      if (archivedModifierAt(a, n.effect.chunk)?.contentLayer === 1) return true;
    }
    if (hasBackgroundLayer(a, n.children ?? [])) return true;
    for (const st of n.states ?? []) if (hasBackgroundLayer(a, st.children)) return true;
  }
  return false;
}

// ios label colours (primary text) per colour scheme
const LABEL_LIGHT: RGBA = [0, 0, 0, 1];
const LABEL_DARK: RGBA = [1, 1, 1, 1];
// wall-clock text can also show day periods and separators
const CLOCK_CHARS = [...'0123456789: APM'];

// formats an ICU date skeleton (the subset widgets use: J/j/h/H hours, mm, ss, a, E, d, M, y) with Intl. J means the
// locale's hour without a day period
export function formatClock(c: WallClock, now: number): string {
  const t = c.template;
  const count = (ch: string) => (t.match(new RegExp(`${ch}+`))?.[0].length ?? 0);
  const o: Intl.DateTimeFormatOptions = { timeZone: c.timeZone };
  const hourCh = ['J', 'j', 'h', 'H'].find((ch) => t.includes(ch));
  if (hourCh) {
    o.hour = count(hourCh) > 1 ? '2-digit' : 'numeric';
    if (hourCh === 'H') o.hourCycle = 'h23';
    if (hourCh === 'h') o.hour12 = true;
  }
  if (t.includes('m')) o.minute = '2-digit';
  if (t.includes('s')) o.second = '2-digit';
  if (t.includes('E')) o.weekday = count('E') >= 4 ? 'long' : 'short';
  if (t.includes('d')) o.day = 'numeric';
  if (t.includes('M')) o.month = count('M') >= 4 ? 'long' : count('M') === 3 ? 'short' : 'numeric';
  if (t.includes('y')) o.year = 'numeric';
  try {
    const parts = new Intl.DateTimeFormat(c.locale?.replace('_', '-'), o).formatToParts(new Date(now));
    const drop = hourCh === 'J' && !t.includes('a');
    return parts
      .filter((p, i) => !(drop && (p.type === 'dayPeriod' || (p.type === 'literal' && parts[i + 1]?.type === 'dayPeriod'))))
      .map((p) => p.value)
      .join('')
      .trim();
  } catch {
    return '';
  }
}
const IOS_PROGRESS_TRACK: RGBA = [120 / 255, 120 / 255, 128 / 255, 0.25];

// greedy line breaking for display-time text: break after spaces and hyphens, inside a word only when the word
// alone is wider than the line. width(idx) measures a candidate line without its trailing spaces
export function breakLines(chars: string[], width: (idx: number[]) => number, max: number): number[][] {
  const lines: number[][] = [];
  let line: number[] = [];
  let i = 0;
  const fits = (idx: number[]) => width(idx) <= max + 0.5;
  while (i < chars.length) {
    // next segment: up to and including the spaces after a word, or up to a hyphen
    const seg: number[] = [];
    while (i < chars.length) {
      seg.push(i);
      const ch = chars[i]!;
      i++;
      if (ch === '\n') break;
      if (/[-\u2010\u2013]/.test(ch) && !/\s/.test(chars[i] ?? ' ')) break;
      if (/\s/.test(ch) && !/\s/.test(chars[i] ?? 'x')) break;
    }
    if (fits([...line, ...seg]) && chars[line.at(-1) ?? -1] !== '\n') {
      line.push(...seg);
      continue;
    }
    if (line.length) lines.push(line);
    line = [];
    // a segment wider than a whole line breaks by character
    for (const ci of seg) {
      if (line.length && !fits([...line, ci]) && !/\s/.test(chars[ci]!)) {
        lines.push(line);
        line = [];
      }
      line.push(ci);
    }
  }
  if (line.length) lines.push(line);
  return lines;
}

// ios timer text: m:ss under an hour, h:mm:ss above. countdowns round up so they read the full duration at the start
// and 0:00 exactly at the end; count-ups round down and stop at the end
export function formatTimer(t: Timer, now: number): string {
  if (t.start === undefined || t.end === undefined) return '';
  const total = Math.max(0, t.end - t.start);
  const ms = t.countdown ? Math.min(total, Math.max(0, t.end - now)) : Math.min(total, Math.max(0, now - t.start));
  const secs = t.countdown ? Math.ceil(ms / 1000) : Math.floor(ms / 1000);
  const [hh, mm, ss] = [Math.floor(secs / 3600), Math.floor(secs / 60) % 60, secs % 60];
  const p2 = (v: number) => String(v).padStart(2, '0');
  return hh ? `${hh}:${p2(mm)}:${p2(ss)}` : `${mm}:${p2(ss)}`;
}

// filled share of a timed progress view: elapsed share, or remaining share when counting down
export function progressFraction(p: Progress, now: number): number {
  if (p.start === undefined || p.end === undefined || p.end <= p.start) return p.fraction ?? 0;
  const f = Math.min(1, Math.max(0, (now - p.start) / (p.end - p.start)));
  return p.countdown ? 1 - f : f;
}
const fnv = (b: Uint8Array) => b.reduce((h, c) => Math.imul(h ^ c, 16777619) >>> 0, 2166136261);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const mat = (m: Affine) => `matrix(${m.map(num).join(' ')})`;
const invert = (m: Affine): Affine | undefined => {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return undefined;
  const [a, b, c, d] = [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
};
const isIdentity = (m: Affine) => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const hexColor = (c: RGBA) => '#' + c.slice(0, 3).map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('');

// fill="…" fill-opacity="…" for a colour
function colorAttrs(c: RGBA, prop: 'fill' | 'stroke' | 'flood-color' | 'stop-color' = 'fill'): string {
  const op = prop === 'flood-color' ? 'flood-opacity' : prop === 'stop-color' ? 'stop-opacity' : `${prop}-opacity`;
  return `${prop}="${hexColor(c)}"` + (c[3] < 1 ? ` ${op}="${num(clamp01(c[3]))}"` : '');
}

const BLEND: Record<number, string> = {
  1: 'multiply', 2: 'screen', 3: 'overlay', 4: 'darken', 5: 'lighten', 6: 'color-dodge', 7: 'color-burn', 8: 'soft-light',
  9: 'hard-light', 10: 'difference', 11: 'exclusion', 12: 'hue', 13: 'saturation', 14: 'color', 15: 'luminosity', 26: 'multiply', 27: 'plus-lighter',
};

// vertical line layout of display-time text in a box of height h. Without paragraph metrics the frame's height
// gives the line count (the frame is the text's own size) and lines share it evenly. Line spacing, a line height
// multiple and minimum/maximum line heights fix the pitch instead: lineH = clamp(natural x multiple), lines are
// lineH + spacing apart and the block is centred in the box
function lineLayout(c: TextContent, natural: number, h: number): { slots: number; lineH: number; top: (i: number) => number } {
  const limit = c.lineLimit ?? Infinity;
  const metrics = c.lineSpacing !== undefined || c.lineHeightMultiple !== undefined || c.maxLineHeight !== undefined || c.minLineHeight !== undefined;
  if (!metrics) {
    const slots = Math.min(limit, Math.max(1, Math.round(h / natural)));
    const pitch = h / slots;
    return { slots, lineH: pitch, top: (i) => i * pitch };
  }
  let lineH = natural * (c.lineHeightMultiple ?? 1);
  if (c.maxLineHeight !== undefined) lineH = Math.min(lineH, c.maxLineHeight);
  if (c.minLineHeight !== undefined) lineH = Math.max(lineH, c.minLineHeight);
  const gap = c.lineSpacing ?? 0;
  const step = Math.max(1, lineH + gap);
  const slots = Math.min(limit, Math.max(1, Math.round((h + gap) / step)));
  const top0 = (h - (slots * lineH + (slots - 1) * gap)) / 2;
  return { slots, lineH, top: (i) => top0 + i * step };
}

// svg filter primitives for a filter chain, each reading the previous result (SourceGraphic first)
function filterPrimitives(fs: Filter[], warn: (s: string) => void): string {
  let out = '';
  let prev = 'SourceGraphic';
  let n = 0;
  const next = () => `r${n++}`;
  for (const f of fs) {
    const r = next();
    switch (f.kind) {
      case 'blur':
        out += `<feGaussianBlur in="${prev}" stdDeviation="${num(f.radius / 2)}" result="${r}"/>`;
        break;
      case 'shadow': {
        const sd = num(f.radius / 2);
        const flood = `<feFlood ${colorAttrs(f.color, 'flood-color')} result="${r}c"/>`;
        if (f.inner) {
          // inner shadow: the offset, blurred inverse of the coverage, kept inside the coverage
          out +=
            `<feComponentTransfer in="${prev}" result="${r}i"><feFuncA type="table" tableValues="1 0"/></feComponentTransfer>` +
            `<feOffset in="${r}i" dx="${num(f.dx)}" dy="${num(f.dy)}" result="${r}o"/><feGaussianBlur in="${r}o" stdDeviation="${sd}" result="${r}b"/>` +
            flood +
            `<feComposite in="${r}c" in2="${r}b" operator="in" result="${r}s"/><feComposite in="${r}s" in2="${prev}" operator="in" result="${f.only ? r : `${r}k`}"/>`;
          if (!f.only) out += `<feMerge result="${r}"><feMergeNode in="${prev}"/><feMergeNode in="${r}k"/></feMerge>`;
        } else if (f.only) {
          out +=
            `<feOffset in="${prev}" dx="${num(f.dx)}" dy="${num(f.dy)}" result="${r}o"/><feGaussianBlur in="${r}o" stdDeviation="${sd}" result="${r}b"/>` +
            flood +
            `<feComposite in="${r}c" in2="${r}b" operator="in" result="${r}"/>`;
        } else out += `<feDropShadow in="${prev}" dx="${num(f.dx)}" dy="${num(f.dy)}" stdDeviation="${sd}" ${colorAttrs(f.color, 'flood-color')} result="${r}"/>`;
        break;
      }
      case 'matrix':
        out += `<feColorMatrix in="${prev}" type="matrix" values="${f.m.map(num).join(' ')}" result="${r}"/>`;
        break;
      case 'saturation':
        out += `<feColorMatrix in="${prev}" type="saturate" values="${num(f.v)}" result="${r}"/>`;
        break;
      case 'brightness':
        out += `<feComponentTransfer in="${prev}" result="${r}">${['R', 'G', 'B'].map((c) => `<feFunc${c} type="linear" slope="1" intercept="${num(f.v)}"/>`).join('')}</feComponentTransfer>`;
        break;
      case 'curve': {
        if (f.values.length < 2) continue;
        const k = f.values.length - 1;
        const table = f.values.map((v, i) => num(f.amount * v + (1 - f.amount) * (i / k))).join(' ');
        out += `<feComponentTransfer in="${prev}" result="${r}">${['R', 'G', 'B'].map((c) => `<feFunc${c} type="table" tableValues="${table}"/>`).join('')}</feComponentTransfer>`;
        break;
      }
      case 'multiply':
        out += `<feColorMatrix in="${prev}" type="matrix" values="${num(f.color[0])} 0 0 0 0 0 ${num(f.color[1])} 0 0 0 0 0 ${num(f.color[2])} 0 0 0 0 0 ${num(f.color[3])} 0" result="${r}"/>`;
        break;
      case 'luminanceToAlpha':
        out += `<feColorMatrix in="${prev}" type="luminanceToAlpha" result="${r}"/>`;
        break;
      default:
        warn(`filter ${f.field} unsupported`);
        continue;
    }
    prev = r;
  }
  return out;
}

class Renderer {
  defs: string[] = [];
  texts: string[] = [];
  labels: string[] = [];
  private runs: { text: string; x: number; y: number }[] = [];
  private labelStack: string[] = [];
  // content transitions: the innermost one applies; keys come from the nearest stable identity
  private transitions: Transition[] = [];
  private stableKeys: string[] = [];
  private keyUses = new Map<string, number>();
  private chars?: string[]; // set while drawing text that the webapp animates per character
  private ctm: Affine = [1, 0, 0, 1, 0, 0];
  private stateHints: string[][] = [];
  controls: Control[] = [];
  private compositing = 0;
  private charSource?: string[];
  private charPos = 0;
  warnings = new Set<string>();
  private ids = 0;
  private glyphs = new Map<string, string>();
  constructor(
    private a: Archive,
    private prefix: string,
    private now: number,
    private textColor: RGBA,
  ) {}

  private id(p: string) {
    return `${this.prefix}${p}${this.ids++}`;
  }
  private warn(s: string) {
    this.warnings.add(s);
  }

  // siblings composite in order; copy (17), source-in (18) and destination-out (23) rewrite what is already drawn
  nodes(ns: Node[]): string {
    let acc = '';
    const entry = { ctm: this.ctm, svg: () => acc };
    this.behind.push(entry);
    try {
      for (const n of ns) {
      const mode = n.effect?.kind === 'blend' ? n.effect.mode : 0;
      if (mode === 17 || mode === 18 || mode === 23) {
        this.compositing++;
        const src = this.node(n);
        this.compositing--;
        acc = this.compose(acc, src, mode);
      } else acc += this.node(n);
      }
    } finally {
      this.behind.pop();
    }
    return acc;
  }

  // what has been drawn so far at every enclosing level, for backdrops: each entry in its own coordinate space
  private behind: { ctm: Affine; svg: () => string }[] = [];
  withBehind<T>(svg: string, fn: () => T): T {
    this.behind.push({ ctm: this.ctm, svg: () => svg });
    try {
      return fn();
    } finally {
      this.behind.pop();
    }
  }

  // a material: everything behind the item, filtered (blur, saturation, tone curve...), clipped to the item's frame,
  // then the material's tint on top. live data attributes are dropped from the copy so only the original animates
  private backdrop(c: Extract<Content, { kind: 'backdrop' }>, w: number, h: number): string {
    const tint = c.color && c.color[3] > 0 ? `<rect width="${num(w)}" height="${num(h)}" ${colorAttrs(c.color)}/>` : '';
    const inv = invert(this.ctm);
    let copy = '';
    if (inv)
      for (const e of this.behind) {
        const svg = e.svg();
        if (!svg) continue;
        const m = mul(inv, e.ctm);
        copy += isIdentity(m) ? svg : `<g transform="${mat(m)}">${svg}</g>`;
      }
    copy = copy.replace(/ data-la-[a-z-]+="[^"]*"/g, '');
    if (!copy || !c.filters.length) return tint;
    if (copy.length > 4_000_000) {
      this.warn('backdrop too large to copy; drew its tint only');
      return tint;
    }
    const fid = this.filter(c.filters, { x: 0, y: 0, w, h });
    const cid = this.id('c');
    this.defs.push(`<clipPath id="${cid}"><rect width="${num(w)}" height="${num(h)}"/></clipPath>`);
    // blur edges sample transparency beyond the copied content; edgeMode duplicate would need a bounded input, so the
    // blur reads a slightly larger region and the clip trims it
    return `<g clip-path="url(#${cid})">${fid ? `<g filter="url(#${fid})">${copy}</g>` : copy}</g>` + tint;
  }

  // porter-duff modes svg lacks, built from masks over what this group has drawn so far
  private compose(acc: string, src: string, mode: number): string {
    if (!src) return mode === 18 ? '' : acc;
    if (!acc) return mode === 23 ? '' : src;
    const id = this.id('m');
    const region = 'maskUnits="userSpaceOnUse" x="-4000" y="-4000" width="8000" height="8000"';
    if (mode === 18) {
      // source-in: the source where the destination has coverage; the destination itself goes
      this.defs.push(`<mask id="${id}" ${region} style="mask-type:alpha">${acc}</mask>`);
      return `<g mask="url(#${id})">${src}</g>`;
    }
    // copy and destination-out first clear the source's coverage from the destination
    const black = this.id('f');
    this.defs.push(`<filter id="${black}" ${region.replace('maskUnits', 'filterUnits')}><feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0"/></filter>`);
    this.defs.push(`<mask id="${id}" ${region}><rect x="-4000" y="-4000" width="8000" height="8000" fill="#fff"/><g filter="url(#${black})">${src}</g></mask>`);
    return `<g mask="url(#${id})">${acc}</g>` + (mode === 17 ? src : '');
  }

  node(n: Node): string {
    const { x, y } = n.frame;
    const at = (inner: string) => (inner && (x || y) ? `<g transform="translate(${num(x)} ${num(y)})">${inner}</g>` : inner);
    let out = '';
    const stable = n.id !== undefined ? this.a.stableId(n.id) : undefined;
    if (stable) this.stableKeys.push(stable);
    const parentCtm = this.ctm;
    this.ctm = mul(parentCtm, [1, 0, 0, 1, x, y]);
    const own = n.content ? this.content(n.content, n.frame) : '';
    out += at(own);
    if (own && (n.effect || n.states?.length)) this.behind.push({ ctm: this.ctm, svg: () => own });
    if (n.effect) {
      // an enclosing accessibility label stands in for glyphs we cannot map back to characters
      const label = n.effect.kind === 'accessibility' && n.effect.label && (n.effect.traits ?? 0) & 256 ? n.effect.label : undefined;
      const tr = n.effect.kind === 'transition' ? n.effect.transition : undefined;
      const mod = n.effect.kind === 'group' && n.effect.chunk !== undefined ? this.modifier(n.effect.name ?? '', n.effect.chunk, n.frame) : undefined;
      if (label) this.labelStack.push(label);
      if (tr) this.transitions.push(tr);
      if (mod) this.stateHints.push(mod);
      const own = this.ctm;
      if (n.effect.kind === 'transform') this.ctm = mul(own, n.effect.m);
      const inner = this.nodes(n.children ?? []);
      this.ctm = own;
      if (label) this.labelStack.pop();
      if (tr) this.transitions.pop();
      if (mod) this.stateHints.pop();
      let drawn = this.effect(n.effect, inner, n.frame);
      if (drawn && n.effect.kind === 'group' && n.effect.chunk !== undefined) drawn = this.clockHand(n.effect.chunk, n.frame, drawn);
      if (drawn && n.effect.kind === 'group' && n.effect.name === 'WidgetKit.WidgetAccentedDesaturatedViewModifier' && this.renderingMode === 1)
        drawn = this.accentedDesaturate(drawn, n.frame);
      out += at(drawn);
    }
    if (n.states?.length) out += at(this.nodes(this.restingState(n.states).children));
    if (own && (n.effect || n.states?.length)) this.behind.pop();
    this.ctm = parentCtm;
    if (stable) this.stableKeys.pop();
    return out;
  }

  // rendering mode of the state: 0 full colour, 1 accented, 2 vibrant
  renderingMode = 0;
  // in accented mode the system desaturates images marked with widgetAccentedRenderingMode (the archived
  // WidgetAccentedDesaturatedViewModifier, {accented}); accented ones are then tinted with the accent colour, which the
  // archive does not carry, so they keep the neutral (white) tint the rest of the content already resolved to
  private accentedDesaturate(inner: string, frame: Rect): string {
    const fid = this.filter([{ kind: 'saturation', v: 0 }], frame);
    return fid ? `<g filter="url(#${fid})">${inner}</g>` : inner;
  }

  // interactive state lists are keyed by StrongHash = sha1 of the state value: a toggle's int64 value, otherwise a
  // pressed flag (1 byte). the resting state is the toggle's archived value, else not pressed
  private restingState(states: NonNullable<Node['states']>) {
    const want = [...this.stateHints.flatMap((h) => h).reverse(), PRESSED_FALSE];
    for (const h of want) {
      const s = states.find((st) => st.hash === h);
      if (s) return s;
    }
    this.warn('interactive state without a known resting value; drew the first');
    return states[0]!;
  }

  // archived modifier state: returns the state hashes it pins and records interactive controls
  // WidgetKit._ClockHandRotationEffect { anchor (unit point), period (s), timeZone { identifier } }: the system turns the
  // subtree continuously with wall-clock time; angle 0 is the hand at 12, reached at local midnight in that zone
  private clockHand(chunk: number, frame: Rect, inner: string): string {
    const m = this.archivedModifier(chunk);
    if (typeof m?.period !== 'number' || m.period <= 0) return inner;
    const [ax, ay] = Array.isArray(m.anchor) ? m.anchor : [0.5, 0.5];
    const cx = frame.w * ax;
    const cy = frame.h * ay;
    const epoch = localMidnight(this.now, m.timeZone?.identifier);
    const deg = ((((this.now - epoch) / (m.period * 1000)) * 360) % 360 + 360) % 360;
    return (
      `<g data-la-rotate-period="${num(m.period)}" data-la-rotate-epoch="${Math.round(epoch)}" data-la-rotate-cx="${num(cx)}" data-la-rotate-cy="${num(cy)}"` +
      ` transform="rotate(${num(deg)} ${num(cx)} ${num(cy)})">${inner}</g>`
    );
  }

  private archivedModifier(chunk: number): any {
    return archivedModifierAt(this.a, chunk);
  }

  private modifier(name: string, chunk: number, frame: Rect): string[] | undefined {
    const known = KNOWN_MODIFIERS[name];
    if (!known) unknown(`modifier-type:${name}`);
    else {
      const m = this.archivedModifier(chunk);
      if (m && typeof m === 'object') for (const k of Object.keys(m)) if (!known.includes(k)) unknown(`bplist-key:modifier.${name}.${k}`);
    }
    const p: any = (() => {
      const b = this.a.chunk(chunk);
      if (!isBplist(b)) return undefined;
      try {
        const v = parseBplist(b);
        return Array.isArray(v) ? v[0] : v;
      } catch {
        return undefined;
      }
    })();
    const m = p?.modifier;
    if (!m) return undefined;
    const rect = this.rectOf(frame);
    const intent = (raw: unknown) => (raw instanceof Uint8Array ? { raw: Buffer.from(raw).toString('base64'), decoded: summarizeAction(unarchive(raw)) } : undefined);
    const ts = m.toggleState;
    if (ts && typeof ts.value === 'number') {
      this.controls.push({ rect, kind: 'toggle', modifier: name, isOn: ts.value === 0, toggleValue: ts.value, isEnabled: m.isEnabled, action: intent(ts.appIntentAction?.lnAction) });
      return [sha1Hex(int64le(ts.value))];
    }
    // ArchivableButtonAppIntentModifier: { action { lnAction }, isEnabled }
    const lnAction = m.action?.lnAction ?? m.action?.appIntentAction?.lnAction ?? m.appIntentAction?.lnAction;
    if (lnAction instanceof Uint8Array) this.controls.push({ rect, kind: 'button', modifier: name, isEnabled: m.isEnabled, action: intent(lnAction) });
    // ArchivableLinkModifier { configuration { url } } and WidgetURLModifier { url }
    const url = m.configuration?.url?.relative ?? m.url?.relative;
    if (typeof url === 'string') this.controls.push({ rect, kind: 'link', modifier: name, url });
    return undefined;
  }

  // the ctm already includes this node's origin, so the frame maps from (0, 0)
  private rectOf(f: Rect) {
    const t = this.ctm;
    const pts = [[0, 0], [f.w, 0], [0, f.h], [f.w, f.h]].map(([px, py]) => [t[0] * px! + t[2] * py! + t[4], t[1] * px! + t[3] * py! + t[5]]);
    const xs = pts.map((q) => q[0]!);
    const ys = pts.map((q) => q[1]!);
    const r = (v: number) => +v.toFixed(2);
    return { x: r(Math.min(...xs)), y: r(Math.min(...ys)), w: r(Math.max(...xs) - Math.min(...xs)), h: r(Math.max(...ys) - Math.min(...ys)) };
  }


  private effect(e: Effect, inner: string, frame?: Rect): string {
    if (!inner) return '';
    switch (e.kind) {
      case 'opacity':
        return e.value >= 1 ? inner : `<g opacity="${num(e.value)}">${inner}</g>`;
      case 'transform':
        return isIdentity(e.m) ? inner : `<g transform="${mat(e.m)}">${inner}</g>`;
      case 'clip': {
        if (!e.shape.parts.length) return inner;
        const id = this.id('c');
        const rule = e.shape.eo ? ' clip-rule="evenodd"' : '';
        this.defs.push(`<clipPath id="${id}">${e.shape.parts.map((p) => `<path d="${p.d}"${rule}/>`).join('')}</clipPath>`);
        return `<g clip-path="url(#${id})">${inner}</g>`;
      }
      case 'mask': {
        const id = this.id('m');
        this.defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" x="-4000" y="-4000" width="8000" height="8000" style="mask-type:alpha">${this.nodes(e.children)}</mask>`);
        return `<g mask="url(#${id})">${inner}</g>`;
      }
      case 'filter': {
        const fid = this.filter(e.filters, frame);
        return fid ? `<g filter="url(#${fid})">${inner}</g>` : inner;
      }
      case 'blend': {
        const mode = BLEND[e.mode];
        if (e.mode === 0) return inner;
        // composited by the parent's nodes()
        if (this.compositing && (e.mode === 17 || e.mode === 18 || e.mode === 23)) return inner;
        if (!mode) {
          this.warn(`blend mode ${e.mode} unsupported`);
          return e.mode === 23 ? '' : inner;
        }
        return `<g style="mix-blend-mode:${mode}">${inner}</g>`;
      }
      case 'transition':
        return `<g data-la-transition="${e.transition.kind}">${inner}</g>`;
      case 'accessibility':
        if (e.label && e.traits !== undefined && e.traits & 256) this.labels.push(e.label);
        return inner;
      case 'group':
      case 'passthrough':
        return inner;
    }
  }

  // the region is in user space around the item's frame: bounding-box units collapse to nothing on zero-width
  // content (a clock hand is a vertical line), and the margin leaves room for blur and shadow offsets
  private filter(fs: Filter[], frame?: Rect): string | undefined {
    const prims = filterPrimitives(fs, (k) => this.warn(k));
    if (!prims) return undefined;
    const id = this.id('f');
    this.defs.push(`<filter id="${id}" ${filterRegion(fs, frame)} color-interpolation-filters="sRGB">${prims}</filter>`);
    return id;
  }

  private content(c: Content, frame: Rect): string {
    const { w, h } = frame;
    switch (c.kind) {
      case 'color':
        return `<rect width="${num(w)}" height="${num(h)}" ${colorAttrs(c.color)}/>`;
      case 'image':
        return this.image(c.image, w, h);
      case 'shadow': {
        if (!c.shape.parts.length) return '';
        const id = this.id('f');
        this.defs.push(`<filter id="${id}" ${filterRegion([{ kind: 'shadow', color: c.color, radius: c.radius, dx: c.dx, dy: c.dy }], { x: 0, y: 0, w, h })}><feGaussianBlur stdDeviation="${num(c.radius / 2)}"/></filter>`);
        const shift = c.dx || c.dy ? ` transform="translate(${num(c.dx)} ${num(c.dy)})"` : '';
        return `<g filter="url(#${id})"${shift}>${this.parts(c.shape.parts, colorAttrs(c.color), c.shape.eo)}</g>`;
      }
      case 'shape': {
        if (c.shape.badOp !== undefined) this.warn(`path op ${c.shape.badOp} unsupported`);
        const fill = this.paint(c.paint, frame);
        return this.parts(c.shape.parts, fill, c.shape.eo);
      }
      case 'drawing': {
        const rb = this.a.rb(c.chunk);
        if (!rb) {
          this.warn(`drawing chunk ${c.chunk} unreadable`);
          return '';
        }
        const first = this.runs.length;
        const tr = this.transitions.at(-1);
        const perChar = tr && (tr.kind === 'numericText' || tr.kind === 'text') && rb.entries.some((e) => e.item?.shape.kind === 'glyphs');
        if (perChar) {
          this.chars = [];
          // glyphs the cmap cannot name (contextual colons, narrow spaces) take their character from the
          // accessibility label when it has exactly one character per glyph
          const label = [...(this.labelStack.at(-1) ?? '')];
          const count = (l: RBList): number => l.entries.reduce((n, e) => n + (e.item?.shape.kind === 'glyphs' ? e.item.shape.glyphs.length : 0) + (e.group ? count(e.group) : 0), 0);
          this.charSource = label.length && label.length === count(rb) ? label : undefined;
          this.charPos = 0;
        }
        let inner = this.rb(rb);
        this.collectText(first);
        if (perChar && !this.chars!.length) this.chars = undefined;
        if (perChar && this.chars) {
          const key = this.numericKey();
          const down = tr.countsDown ? ' data-la-counts-down="1"' : '';
          const value = tr.value !== undefined ? ` data-la-value="${num(tr.value)}"` : '';
          inner = `<g data-la-numeric="${key}" data-la-text="${esc(this.chars.join(''))}"${down}${value}>${inner}</g>`;
        }
        this.chars = this.charSource = undefined;
        return c.offset.x || c.offset.y ? `<g transform="translate(${num(-c.offset.x)} ${num(-c.offset.y)})">${inner}</g>` : inner;
      }
      case 'flattened': {
        const inner = this.nodes(c.children);
        return c.offset.x || c.offset.y ? `<g transform="translate(${num(-c.offset.x)} ${num(-c.offset.y)})">${inner}</g>` : inner;
      }
      case 'text':
        return this.text(c, w, h);
      case 'platformView': {
        const prog = c.chunk !== undefined && c.chunk >= 0 && /ProgressView/.test(c.name) ? decodeProgress(this.a.chunk(c.chunk)) : undefined;
        if (prog) return this.progress(prog, w, h);
        this.warn(`platform view ${c.name} not archived`);
        // the view's pixels are not in the archive: a neutral fill marks the space without inventing content
        return `<rect width="${num(w)}" height="${num(h)}" rx="${num(Math.min(12, w / 8, h / 8))}" ${colorAttrs(UNAVAILABLE_FILL)}/>`;
      }
      case 'backdrop':
        return this.backdrop(c, w, h);
      case 'unknown':
        this.warn(`content ${c.field} unsupported`);
        return '';
    }
  }

  // redaction placeholders are runs of plane-16 private use characters, each a fixed-advance bar segment;
  // the run breaks across the lines the frame was sized for like any unbreakable word
  private placeholderText(c: TextContent, n: number, size: number, w: number, h: number, col: RGBA): string {
    const lay = lineLayout(c, size * IOS_LINE_HEIGHT, h);
    const bh = Math.min(lay.lineH, size * REDACTION_BAR_EM);
    const per = Math.max(1, Math.floor(w / (size * REDACTION_ADVANCE_EM)));
    let left = n;
    const out: string[] = [];
    for (let i = 0; i < lay.slots && left > 0; i++) {
      const take = i === lay.slots - 1 ? left : Math.min(left, per);
      const bw = Math.min(w, take * size * REDACTION_ADVANCE_EM);
      left -= take;
      const x = c.align === 'middle' ? (w - bw) / 2 : c.align === 'end' ? w - bw : 0;
      out.push(`<rect${x ? ` x="${num(x)}"` : ''} y="${num(lay.top(i) + (lay.lineH - bh) / 2)}" width="${num(bw)}" height="${num(bh)}" rx="${num(bh / 4)}" ${colorAttrs(col)}/>`);
    }
    return out.join('');
  }

  // size variants, padding and shadows around the text itself
  private text(c: TextContent, w: number, h: number): string {
    let t = c;
    if (c.variants?.length) {
      const all = [c, ...c.variants];
      t = all.find((v) => this.textFits(v, w, h)) ?? all.at(-1)!;
    }
    let [ox, oy, W, H] = [0, 0, w, h];
    if (t.padding) {
      // the frame is the text's size plus the padding (rounded up): centre the text box in what remains
      const [pt, pl, pb, pr] = t.padding;
      W = t.size?.w ?? Math.max(0, w - pl - pr);
      H = t.size?.h ?? Math.max(0, h - pt - pb);
      ox = pl + (w - pl - pr - W) / 2;
      oy = pt + (h - pt - pb - H) / 2;
    }
    let out = this.textBody(t, W, H);
    const sh = t.spans.find((sp) => sp.shadow)?.shadow;
    if (out && sh && sh.color[3] > 1 / 255 && (sh.radius > 0 || sh.dx || sh.dy)) {
      const shadow: Filter = { kind: 'shadow', color: sh.color, radius: sh.radius, dx: sh.dx, dy: sh.dy };
      const fid = this.filter([shadow], { x: 0, y: 0, w: W, h: H });
      if (fid) out = `<g filter="url(#${fid})">${out}</g>`;
    }
    return out && (ox || oy) ? `<g transform="translate(${num(ox)} ${num(oy)})">${out}</g>` : out;
  }

  // whether a size variant fits its frame on the lines it may use (one line per natural line height)
  private textFits(c: TextContent, w: number, h: number): boolean {
    const chars = [...c.text];
    const font = c.fontChunk !== undefined && c.fontChunk >= 0 ? decodeFontDesc(this.a.chunk(c.fontChunk)) : undefined;
    const size = font?.size || h / IOS_LINE_HEIGHT;
    const lines = Math.min(c.lineLimit ?? Infinity, Math.max(1, Math.round(h / (size * IOS_LINE_HEIGHT))));
    let width: number;
    if (chars.length && chars.every((ch) => ch.codePointAt(0)! >= 0x100000)) width = chars.length * size * REDACTION_ADVANCE_EM;
    else {
      const styles = this.textStyles(c, chars, c.color ?? this.textColor, !!c.tabular);
      if (!styles) return true;
      width = chars.reduce((sum, ch, i) => {
        const st = styles[i]!;
        const g = st.gid(ch) ?? -1;
        const space = st.font.glyphFor!(' ');
        return sum + ((g >= 0 ? st.font.advance!(g) : space !== undefined ? st.font.advance!(space) : st.font.unitsPerEm / 4) + st.track) * st.k;
      }, 0);
    }
    return width <= w * lines + Math.max(1.5, w * 0.06);
  }

  private textBody(c: TextContent, w: number, h: number): string {
    const col = c.color ?? this.textColor;
    const chars = [...c.text];
    const placeholder = chars.length > 0 && chars.every((ch) => ch.codePointAt(0)! >= 0x100000);
    const font = c.fontChunk !== undefined && c.fontChunk >= 0 ? decodeFontDesc(this.a.chunk(c.fontChunk)) : undefined;
    if (placeholder) return this.placeholderText(c, chars.length, font?.size || h / IOS_LINE_HEIGHT, w, h, col);
    if (!font?.size) this.warn('attributed text without a font descriptor');
    let size = font?.size || h / IOS_LINE_HEIGHT;
    const weight = font?.weight ?? 400;
    const sys = font?.size ? this.a.textFont(font) : undefined;
    const real = sys?.font?.glyphFor && sys.font.metrics ? sys.font : undefined;
    if (font?.size && !real) this.warn(`no installed font for ${font.ps ?? font.name}: ${sys?.reason}`);
    const tabular = !!(font?.monospacedDigits || c.tabular);
    const sets = (font?.features ?? []).filter((ft) => /^ss\d\d$/.test(ft));
    const glyphOf = (ch: string) => {
      let g = real?.glyphFor?.(ch);
      if (g === undefined || !real?.substitute) return g;
      if (tabular) g = real.substitute(g, 'tnum');
      for (const ft of sets) g = real.substitute(g, ft);
      return g;
    };
    const t = c.timer;
    // live text is one line; a minimum scale factor shrinks it to the width the archived string was laid out in
    const live = (t && t.start !== undefined && t.end !== undefined) || c.clock;
    if (live && c.minScale && real?.advance) {
      let adv = 0;
      let prev: number | undefined;
      for (const ch of c.text) {
        const g = glyphOf(ch) ?? 0;
        adv += real.advance(g) + (real.tracking?.(size) ?? 0) + (prev !== undefined && real.kern ? real.kern(prev, g) : 0);
        prev = g;
      }
      const width = (adv * size) / real.unitsPerEm;
      if (width > w + 0.5) size *= Math.max(c.minScale, w / width);
    }
    // baseline from the font's own line metrics when we have it, centred in the layout box
    const k = real ? size / real.unitsPerEm : 0;
    const y = real
      ? (h - (real.metrics!.ascender - real.metrics!.descender + real.metrics!.lineGap) * k) / 2 + real.metrics!.ascender * k
      : (h - IOS_LINE_HEIGHT * size) / 2 + IOS_ASCENT * size;
    if (t && t.start !== undefined && t.end !== undefined) {
      // the device rewrites timers every second, so they stay live text, in an embedded subset of the real font
      const value = t.style === 'timer' ? formatTimer(t, this.now) : c.text;
      const data =
        ` data-la-timer-start="${Math.round(t.start)}" data-la-timer-end="${Math.round(t.end)}"` +
        ` data-la-timer-countdown="${t.countdown ? 1 : 0}" data-la-timer-style="${t.style}"`;
      this.texts.push(value);
      const face = real ? this.fontFace(real, weight, [...new Set([...TIMER_CHARS, ...value])], glyphOf) : undefined;
      const family = (face ? `'${face}', ` : '') + (font?.rounded ? 'ui-rounded, "SF Pro Rounded", ' : '') + '-apple-system, "SF Pro", system-ui, sans-serif';
      const spacing = (real?.tracking ? real.tracking(size) * k : 0) + (c.spans[0]?.spacing ?? 0);
      const x = c.align === 'middle' ? w / 2 : c.align === 'end' ? w : 0;
      const numeric = tabular ? ' style="font-variant-numeric:tabular-nums"' : '';
      return (
        `<text x="${num(x)}" y="${num(y)}" font-family="${esc(family)}" font-size="${num(size)}" font-weight="${weight}"` +
        `${spacing ? ` letter-spacing="${num(spacing)}"` : ''}${c.align !== 'start' ? ` text-anchor="${c.align}"` : ''} ${colorAttrs(col)}${numeric}${data}>${esc(value)}</text>`
      );
    }
    if (c.clock) {
      // the device keeps wall-clock text current, so it stays live text in an embedded subset of the real font
      const value = formatClock(c.clock, this.now) || c.text;
      this.texts.push(value);
      const face = real ? this.fontFace(real, weight, [...new Set([...CLOCK_CHARS, ...value, ...c.text])], glyphOf) : undefined;
      const family = (face ? `'${face}', ` : '') + (font?.rounded ? 'ui-rounded, "SF Pro Rounded", ' : '') + '-apple-system, "SF Pro", system-ui, sans-serif';
      const spacing = (real?.tracking ? real.tracking(size) * k : 0) + (c.spans[0]?.spacing ?? 0);
      const x = c.align === 'middle' ? w / 2 : c.align === 'end' ? w : 0;
      const data =
        ` data-la-clock-format="${esc(c.clock.template)}"` +
        (c.clock.timeZone ? ` data-la-clock-tz="${esc(c.clock.timeZone)}"` : '') +
        (c.clock.locale ? ` data-la-clock-locale="${esc(c.clock.locale)}"` : '');
      return (
        `<text x="${num(x)}" y="${num(y)}" font-family="${esc(family)}" font-size="${num(size)}" font-weight="${weight}"` +
        `${spacing ? ` letter-spacing="${num(spacing)}"` : ''}${c.align !== 'start' ? ` text-anchor="${c.align}"` : ''} ${colorAttrs(col)}${tabular ? ' style="font-variant-numeric:tabular-nums"' : ''}${data}>${esc(value)}</text>`
      );
    }
    this.texts.push(c.text);
    // shape with installed fonts so widths, line breaks and alignment are the system's own. each attribute range
    // can bring its own font, size, features and colour (e.g. a small-caps "PM" after the hour)
    const styles = this.textStyles(c, chars, col, tabular);
    if (styles) {
      const glyphAt = (i: number) => styles[i]!.gid(chars[i]!) ?? -1;
      const advPt = (i: number, g: number) => {
        const st = styles[i]!;
        const f = st.font;
        const space = f.glyphFor!(' ');
        const adv = g >= 0 ? f.advance!(g) : space !== undefined ? f.advance!(space) : f.unitsPerEm / 4;
        return (adv + st.track) * st.k;
      };
      // one line: x positions in points and the inked width without trailing spaces
      type Run = { idx: number[]; gids: number[]; owners: number[]; xs: number[]; width: number };
      const shape = (idx: number[], ellipsisOf?: number, hyphenOf?: number): Run => {
        const owners = [...idx];
        const gids = idx.map((i) => glyphAt(i));
        if (ellipsisOf !== undefined) {
          const st = styles[ellipsisOf]!;
          const e = st.gid('\u2026');
          const dots = e !== undefined && e >= 0 ? [e] : [0, 1, 2].map(() => st.gid('.') ?? -1).filter((g) => g >= 0);
          for (const g of dots) gids.push(g), owners.push(ellipsisOf);
        }
        if (hyphenOf !== undefined) {
          const st = styles[hyphenOf]!;
          const hy = st.gid('\u2010') ?? st.gid('-');
          if (hy !== undefined && hy >= 0) gids.push(hy), owners.push(hyphenOf);
        }
        const xs: number[] = [];
        let pen = 0;
        let inked = 0;
        gids.forEach((g, j) => {
          xs.push(pen);
          const o = owners[j]!;
          pen += advPt(o, g);
          const next = gids[j + 1];
          const st = styles[o]!;
          if (next !== undefined && styles[owners[j + 1]!] === st && g >= 0 && next >= 0 && st.font.kern) pen += st.font.kern(g, next) * st.k;
          if (j >= idx.length || !/\s/.test(chars[idx[j]!]!)) inked = pen;
        });
        return { idx, gids, owners, xs, width: inked };
      };
      // swiftui sizes the frame to the laid-out text, so its height says how many lines are visible
      const used = [...new Set(styles)];
      const ascent = Math.max(...used.map((st) => st!.font.metrics!.ascender * st!.k));
      const natural = Math.max(...used.map((st) => (st!.font.metrics!.ascender - st!.font.metrics!.descender + st!.font.metrics!.lineGap) * st!.k));
      const all = chars.map((_, i) => i);
      // the frame is the text's own size rounded up, so only clear overflow means the text wraps or truncates;
      // small differences come from font builds and rounding and must never cost a character
      const slotsAt = (hh: number) => lineLayout(c, natural, hh).slots;
      const tol = (ww: number) => Math.max(1.5, ww * 0.06);
      const fullWidth = shape(all).width;
      // a minimum scale factor shrinks the whole text (up to that factor) before anything wraps or truncates:
      // lay out in a box enlarged by 1/scale, then draw scaled down
      let scale = 1;
      if (c.minScale && fullWidth > w + tol(w)) {
        const fits = (sc: number) => {
          const sl = slotsAt(h / sc);
          return sl > 1 && breakLines(chars, (idx) => shape(idx).width, w / sc + 0.5).length <= sl;
        };
        if (slotsAt(h) === 1) scale = Math.max(c.minScale, w / fullWidth);
        else {
          scale = c.minScale;
          for (let sc = 1; sc > c.minScale; sc -= 0.01)
            if (fits(sc)) {
              scale = sc;
              break;
            }
        }
      }
      const W = w / scale;
      const H = h / scale;
      const lay = lineLayout(c, natural, H);
      const slots = lay.slots;
      const tolerance = scale < 1 ? 0.5 : tol(W);
      let lines: number[][] = [all];
      if (fullWidth > W + tolerance) lines = slots > 1 ? breakLines(chars, (idx) => shape(idx).width, W + 0.5) : [all];
      let truncated = false;
      if (lines.length > slots) {
        // the last visible line takes all the remaining text, then tail truncation cuts it by character
        const rest = lines.slice(slots - 1).flat();
        lines = [...lines.slice(0, slots - 1), rest];
        truncated = true;
      }
      // tail truncation: drop characters (and the spaces before the cut) until the line plus "…" fits
      // hyphenation: a line that ends inside a word (the word alone overflowed) gets a hyphen, as CoreText adds one
      // when the paragraph allows hyphenation
      const midWord = (idx: number[], li: number) => {
        const last = idx.at(-1);
        const next = lines[li + 1]?.[0];
        return last !== undefined && next === last + 1 && /\p{L}/u.test(chars[last]!) && /\p{L}/u.test(chars[next]!);
      };
      const runs = lines.map((idx, li) => {
        let run = c.hyphenation && li < lines.length - 1 && midWord(idx, li) ? shape(idx, undefined, idx.at(-1)) : shape(idx);
        if (li === lines.length - 1 && (truncated || run.width > W + tolerance)) {
          const keep = idx.slice();
          const trim = () => {
            while (keep.length && /\s/.test(chars[keep.at(-1)!]!)) keep.pop();
          };
          trim();
          const owner = keep.at(-1) ?? idx[0]!;
          run = shape(keep, owner);
          while (keep.length && run.width > W) {
            keep.pop();
            trim();
            run = shape(keep, owner);
          }
        }
        return run;
      });
      const tr = this.transitions.at(-1);
      const perChar = tr && (tr.kind === 'numericText' || tr.kind === 'text');
      const body = runs
        .map((laid, li) => {
          let run = laid;
          let x0 = c.align === 'middle' ? (W - run.width) / 2 : c.align === 'end' ? W - run.width : 0;
          const yl = lay.top(li) + (lay.lineH - natural) / 2 + ascent;
          // justified paragraphs spread every line but the last (and lines ended by a newline) across the width
          const lastInked = run.idx.findLastIndex((i) => !/\s/.test(chars[i]!));
          const gaps = run.idx.map((i, j) => j < lastInked && /[ \u00a0]/.test(chars[i]!));
          const nGaps = gaps.filter(Boolean).length;
          if (c.justify && li < runs.length - 1 && nGaps && chars[run.idx.at(-1)!] !== '\n' && run.width < W) {
            x0 = 0;
            const extra = (W - run.width) / nGaps;
            let shift = 0;
            run = { ...run, xs: run.xs.map((x, j) => (j > 0 && gaps[j - 1] ? (shift += extra) : shift) + x) };
          }
          // consecutive glyphs of one style share a scaled group
          let out = '';
          let j = 0;
          while (j < run.gids.length) {
            const st = styles[run.owners[j]!]!;

            const segX = run.xs[j]!;
            let uses = '';
            for (; j < run.gids.length && styles[run.owners[j]!] === st; j++) {
              const g = run.gids[j]!;
              if (g < 0) continue;
              const id = this.glyphDef(st.font, g);
              if (!id) continue;
              const use = `<use href="#${id}" x="${num((run.xs[j]! - segX) / st.k)}"/>`;
              const i = j < run.idx.length ? run.idx[j] : undefined;
              uses += perChar && i !== undefined ? `<g data-la-ch="${esc(chars[i]!)}" data-la-i="${i}">${use}</g>` : use;
            }
            if (uses) out += `<g ${colorAttrs(st.color)} transform="matrix(${num(st.k)} 0 0 ${num(-st.k)} ${num(x0 + segX)} ${num(yl)})">${uses}</g>`;
          }
          return out;
        })
        .join('');
      let out = scale < 1 ? `<g transform="scale(${num(scale)})">${body}</g>` : body;
      if (perChar) out = `<g data-la-numeric="${this.numericKey()}" data-la-text="${esc(c.text)}"${tr.countsDown ? ' data-la-counts-down="1"' : ''}${tr.value !== undefined ? ` data-la-value="${num(tr.value)}"` : ''}>${out}</g>`;
      return out;
    }
    const family = (font?.rounded ? 'ui-rounded, "SF Pro Rounded", ' : '') + '-apple-system, "SF Pro", system-ui, sans-serif';
    const x = c.align === 'middle' ? w / 2 : c.align === 'end' ? w : 0;
    const numeric = tabular ? ' style="font-variant-numeric:tabular-nums"' : '';
    return (
      `<text x="${num(x)}" y="${num(y)}" font-family='${family}' font-size="${num(size)}" font-weight="${weight}"` +
      `${c.align !== 'start' ? ` text-anchor="${c.align}"` : ''} ${colorAttrs(col)}${numeric}>${esc(c.text)}</text>`
    );
  }

  private glyphDef(f: Font, g: number): string {
    const key = `${this.fontKey(f)}:${g}`;
    let id = this.glyphs.get(key);
    if (id === undefined) {
      const d = f.glyphPath(g);
      id = d ? this.id('gl') : '';
      if (d) this.defs.push(`<path id="${id}" d="${d}"/>`);
      this.glyphs.set(key, id);
    }
    return id;
  }

  // per-character shaping styles from the attribute ranges; undefined unless every character has an installed font
  private textStyles(c: TextContent, chars: string[], col: RGBA, tabular: boolean) {
    type Style = { font: Font; k: number; track: number; gid: (ch: string) => number | undefined; color: RGBA };
    const styles: (Style | undefined)[] = chars.map(() => undefined);
    const spans = c.spans.length ? c.spans : [{ start: 0, length: chars.length, fontChunk: c.fontChunk, color: c.color }];
    const made = new Map<string, Style | undefined>();
    for (const sp of spans) {
      const key = `${sp.fontChunk}|${sp.color?.join()}|${sp.spacing ?? 0}`;
      if (!made.has(key)) {
        const d = sp.fontChunk !== undefined && sp.fontChunk >= 0 ? decodeFontDesc(this.a.chunk(sp.fontChunk)) : undefined;
        const f = d?.size ? this.a.textFont(d).font : undefined;
        if (!d || !f?.glyphFor || !f.metrics) made.set(key, undefined);
        else {
          const feats = new Set(d.features);
          if (tabular || d.monospacedDigits) feats.add('tnum');
          const gid = (ch: string) => {
            let g = f.glyphFor!(ch);
            if (g === undefined) return /\s/.test(ch) ? -1 : undefined;
            if (f.substitute) {
              if (feats.has('tnum')) g = f.substitute(g, 'tnum');
              if (feats.has('c2sc') && ch !== ch.toLowerCase()) g = f.substitute(g, 'c2sc');
              if (feats.has('smcp') && ch !== ch.toUpperCase()) g = f.substitute(g, 'smcp');
              for (const ft of feats) if (/^ss\d\d$/.test(ft)) g = f.substitute(g, ft);
            }
            return g;
          };
          // the font's own size-specific tracking plus the range's kerning/tracking (points, after each character)
          const k = d.size / f.unitsPerEm;
          made.set(key, { font: f, k, track: (f.tracking?.(d.size) ?? 0) + (sp.spacing ?? 0) / k, gid, color: sp.color ?? col });
        }
      }
      for (let i = sp.start; i < sp.start + sp.length && i < chars.length; i++) styles[i] = made.get(key);
    }
    if (styles.some((st, i) => !st || st.gid(chars[i]!) === undefined)) return undefined;
    return styles as Style[];
  }

  private fontIds = new Map<Font, string>();
  private fontKey(f: Font): string {
    let k = this.fontIds.get(f);
    if (!k) this.fontIds.set(f, (k = `t${this.fontIds.size}`));
    return k;
  }

  private faces = new Map<string, string>();
  // a static subset of the instanced font as an @font-face, so the device draws the real digits
  private fontFace(f: Font, weight: number, chars: string[], glyphOf: (ch: string) => number | undefined): string | undefined {
    const key = `${this.fontKey(f)}|${weight}|${chars.sort().join('')}`;
    let name = this.faces.get(key);
    if (name !== undefined) return name || undefined;
    name = `${this.prefix}f${this.faces.size}`;
    const ttf = buildSubset(f, chars, name, weight, glyphOf);
    if (!ttf) {
      this.faces.set(key, '');
      return undefined;
    }
    this.faces.set(key, name);
    // the face declares the weight it was instanced at, so browsers do not embolden it synthetically
    this.defs.push(`<style>@font-face{font-family:'${name}';font-weight:${Math.round(weight)};src:url(data:font/ttf;base64,${Buffer.from(ttf).toString('base64')}) format('truetype')}</style>`);
    return name;
  }

  // stable across archive versions: the nearest stable identity, numbered per animated text beneath it
  private numericKey(): string {
    const base = this.stableKeys.at(-1) ?? 'root';
    const n = this.keyUses.get(base) ?? 0;
    this.keyUses.set(base, n + 1);
    return n ? `${base}.${n}` : base;
  }

  // linear progress: ios draws a capsule bar of fixed thickness centred in the view's frame
  private progress(p: Progress, w: number, h: number): string {
    const y = (h - IOS_PROGRESS_THICKNESS) / 2;
    const r = IOS_PROGRESS_THICKNESS / 2;
    const tint = p.tint ?? this.textColor;
    let frac = p.fraction ?? 0;
    let data = '';
    if (p.start !== undefined && p.end !== undefined) {
      frac = progressFraction(p, this.now);
      data =
        ` data-la-progress-start="${Math.round(p.start)}" data-la-progress-end="${Math.round(p.end)}"` +
        ` data-la-progress-countdown="${p.countdown ? 1 : 0}" data-la-progress-width="${num(w)}"`;
    }
    const bar = (fw: number, attrs: string, extra = '') =>
      `<rect y="${num(y)}" width="${num(fw)}" height="${num(IOS_PROGRESS_THICKNESS)}" rx="${num(r)}" ${attrs}${extra}/>`;
    return bar(w, colorAttrs(IOS_PROGRESS_TRACK)) + bar(w * frac, colorAttrs(tint), data);
  }

  private parts(parts: PathPart[], fill: string, eo?: boolean): string {
    return parts
      .map((p) => {
        if (p.stroke) {
          const s = p.stroke;
          const stroke = fill.replace(/^fill=/, 'stroke=').replace(/fill-opacity=/, 'stroke-opacity=');
          return `<path d="${p.d}" fill="none" ${stroke} stroke-width="${num(s.width)}"${s.cap !== 'butt' ? ` stroke-linecap="${s.cap}"` : ''}${s.join !== 'miter' ? ` stroke-linejoin="${s.join}"` : ''}${s.dash?.length ? ` stroke-dasharray="${s.dash.map(num).join(' ')}"${s.dashPhase ? ` stroke-dashoffset="${num(s.dashPhase)}"` : ''}` : ''}/>`;
        }
        return `<path d="${p.d}" ${fill}${eo ? ' fill-rule="evenodd"' : ''}/>`;
      })
      .join('');
  }

  private paint(p: Paint, frame: Rect): string {
    // unit points are relative to the paint's anchor rect when it has one, else to the shape's frame
    const box = (p.kind === 'linear' || p.kind === 'radial' || p.kind === 'angular') && p.anchor ? p.anchor : { x: 0, y: 0, w: frame.w, h: frame.h };
    const ux = (u: number) => box.x + u * box.w;
    const uy = (u: number) => box.y + u * box.h;
    switch (p.kind) {
      case 'color':
        return colorAttrs(p.color);
      case 'linear': {
        if (p.units === 'abs') return this.gradient('linear', p.stops, `x1="${num(p.from.x)}" y1="${num(p.from.y)}" x2="${num(p.to.x)}" y2="${num(p.to.y)}"`);
        return this.gradient('linear', p.stops, `x1="${num(ux(p.from.x))}" y1="${num(uy(p.from.y))}" x2="${num(ux(p.to.x))}" y2="${num(uy(p.to.y))}"`);
      }
      case 'radial':
        return this.gradient('radial', p.stops, `cx="${num(ux(p.center.x))}" cy="${num(uy(p.center.y))}" r="${num(p.r1)}" fr="${num(p.r0)}"`);
      case 'angular':
        return this.angular(p.stops, ux(p.center.x), uy(p.center.y), p.start, p.end);
      case 'unknown':
        this.warn(`paint ${p.field} unsupported`);
        return 'fill="#808080"';
    }
  }

  // svg has no conic gradient: a pattern of thin wedges around the centre, each filled with the colour at its
  // angle. angles run clockwise from +x (y down); outside [start, end] the end colours hold
  private angular(stops: Stop[], cx: number, cy: number, start: number, end: number): string {
    if (!stops.length) return 'fill="none"';
    const sorted = [...stops].sort((a, b) => a.at - b.at);
    const at = (t: number): RGBA => {
      if (t <= sorted[0]!.at) return sorted[0]!.color;
      for (let i = 1; i < sorted.length; i++) {
        const [a, b] = [sorted[i - 1]!, sorted[i]!];
        if (t <= b.at) {
          const k = b.at > a.at ? (t - a.at) / (b.at - a.at) : 1;
          return [0, 1, 2, 3].map((j) => a.color[j]! + (b.color[j]! - a.color[j]!) * k) as RGBA;
        }
      }
      return sorted.at(-1)!.color;
    };
    const span = end - start || Math.PI * 2;
    const N = 180;
    const R = 4000;
    const step = (Math.PI * 2) / N;
    const pt = (a: number) => `${num(cx + R * Math.cos(a))} ${num(cy + R * Math.sin(a))}`;
    let wedges = '';
    for (let i = 0; i < N; i++) {
      const a0 = start + i * step;
      const t = (a0 + step / 2 - start) / span;
      // a small overlap hides the seams antialiasing leaves between opaque neighbours (translucent ones would
      // double up where they overlap)
      const c = at(Math.min(1, Math.max(0, t)));
      const o = c[3] >= 1 ? 0.3 : 0;
      wedges += `<path d="M${num(cx)} ${num(cy)}L${pt(a0 - step * o)}L${pt(a0 + step * (1 + o))}Z" ${colorAttrs(c)}/>`;
    }
    const id = this.id('p');
    this.defs.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" x="-4000" y="-4000" width="8000" height="8000"><g transform="translate(4000 4000)">${wedges}</g></pattern>`);
    return `fill="url(#${id})"`;
  }

  private gradient(kind: 'linear' | 'radial', stops: Stop[], attrs: string): string {
    const id = this.id('g');
    const st = stops.map((s) => `<stop offset="${num(clamp01(s.at))}" ${colorAttrs(s.color, 'stop-color')}/>`).join('');
    this.defs.push(`<${kind}Gradient id="${id}" gradientUnits="userSpaceOnUse" ${attrs}>${st}</${kind}Gradient>`);
    return `fill="url(#${id})"`;
  }

  private image(img: Img, w: number, h: number): string {
    const src = img.source;
    switch (src.kind) {
      case 'color':
        return `<rect width="${num(w)}" height="${num(h)}" ${colorAttrs(src.color)}/>`;
      case 'vector': {
        const rb = this.a.rb(src.chunk);
        if (!rb || !src.size.w || !src.size.h) {
          this.warn(`vector image ${src.chunk} unreadable`);
          return '';
        }
        // vector image contents are recorded y-up in a size.w x size.h box
        return `<g transform="matrix(${num(w / src.size.w)} 0 0 ${num(-h / src.size.h)} 0 ${num(h)})">${this.rb(rb, img.tint)}</g>`;
      }
      case 'bitmap': {
        const web = webImage(this.a.chunk(src.chunk));
        if (!web) {
          this.warn(`bitmap ${src.chunk} has unknown encoding`);
          return '';
        }
        const { mime, bytes: b } = web;
        let filter = '';
        if (img.tint) {
          const id = this.id('t');
          this.defs.push(`<filter id="${id}" color-interpolation-filters="sRGB"><feFlood ${colorAttrs(img.tint, 'flood-color')}/><feComposite in2="SourceGraphic" operator="in"/></filter>`);
          filter = ` filter="url(#${id})"`;
        }
        // interpolation none (Image.interpolation(.none), e.g. QR codes and pixel art) keeps hard pixel edges
        const pixelated = img.interpolation === 0 ? ' style="image-rendering:pixelated"' : '';
        if (img.orientation) this.warn(`image orientation ${img.orientation} not applied`);
        const iw = img.pixelSize.w / (img.scale || 1);
        const ih = img.pixelSize.h / (img.scale || 1);
        const rz = img.resizing;
        const resized = rz && iw > 0 && ih > 0 && (Math.abs(iw - w) > 0.01 || Math.abs(ih - h) > 0.01) && (rz.tile || rz.caps.some((v) => v > 0));
        if (resized) {
          // resizable(capInsets:resizingMode:): the caps keep their size, the middle stretches or tiles
          const id = this.id('i');
          this.defs.push(`<image id="${id}" width="${num(iw)}" height="${num(ih)}" preserveAspectRatio="none"${pixelated} href="data:${mime};base64,${base64(b)}"/>`);
          const [t, l, bo, r] = rz.caps;
          const xs = [[0, l, 0, l], [l, iw - r, l, w - r], [iw - r, iw, w - r, w]] as const;
          const ys = [[0, t, 0, t], [t, ih - bo, t, h - bo], [ih - bo, ih, h - bo, h]] as const;
          let cells = '';
          for (const [sx0, sx1, dx0, dx1] of xs)
            for (const [sy0, sy1, dy0, dy1] of ys) {
              const [sw, sh, dw, dh] = [sx1 - sx0, sy1 - sy0, dx1 - dx0, dy1 - dy0];
              if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) continue;
              const middle = sx0 === l && sx1 === iw - r || sy0 === t && sy1 === ih - bo;
              if (rz.tile && middle) {
                const pid = this.id('p');
                this.defs.push(`<pattern id="${pid}" patternUnits="userSpaceOnUse" x="${num(dx0)}" y="${num(dy0)}" width="${num(sw)}" height="${num(sh)}"><use href="#${id}" x="${num(-sx0)}" y="${num(-sy0)}"/></pattern>`);
                cells += `<rect x="${num(dx0)}" y="${num(dy0)}" width="${num(dw)}" height="${num(dh)}" fill="url(#${pid})"/>`;
              } else
                cells += `<svg x="${num(dx0)}" y="${num(dy0)}" width="${num(dw)}" height="${num(dh)}" viewBox="${num(sx0)} ${num(sy0)} ${num(sw)} ${num(sh)}" preserveAspectRatio="none" overflow="hidden"><use href="#${id}"/></svg>`;
            }
          return filter ? `<g${filter}>${cells}</g>` : cells;
        }
        return `<image width="${num(w)}" height="${num(h)}" preserveAspectRatio="none"${filter}${pixelated} href="data:${mime};base64,${base64(b)}"/>`;
      }
      case 'none':
        return '';
    }
  }

  // ------------------------------------------------------------ renderbox lists

  // copy (17) and destination-out (23) change what is already drawn in this list: everything so far is masked by
  // the entry's coverage (fully for copy, by the source alpha for destination-out), then copy draws the source
  private rbRoots = new Map<RBList['resources'], RBList>();
  private rb(list: RBList, tint?: RGBA): string {
    // the first list drawn with a resource table is the chunk's root; groups share its table
    if (!this.rbRoots.has(list.resources)) this.rbRoots.set(list.resources, list);
    let acc = '';
    for (const e of list.entries) {
      if (e.blend === 17 || e.blend === 18 || e.blend === 23) {
        // destination-out erases by the source's alpha; copy by its coverage, then draws it
        const src = this.rbEntry({ ...e, blend: undefined }, list, tint);
        const cover = e.blend === 17 ? this.rbEntry({ ...e, blend: undefined, alpha: undefined }, list, [0, 0, 0, 1]) : src;
        if (e.blend === 17) acc = this.compose(acc, cover, 23) + src;
        else acc = this.compose(acc, src, e.blend);
        continue;
      }
      acc += this.rbEntry(e, list, tint);
    }
    return acc;
  }


  private rbEntry(e: RBEntry, list: RBList, tint?: RGBA): string {
    let out = '';
    if (e.item) out += this.rbItem(e.item, list, tint);
    if (e.group) out += this.rb({ entries: e.group.entries, resources: list.resources }, tint);
    if (!out) return '';
    for (const c of (e.clip !== undefined ? list.resources.get(e.clip)?.clip : undefined) ?? []) {
      let cover: string;
      if ('shape' in c) {
        if (c.shape.kind !== 'path') continue;
        const t = isIdentity(c.m) ? '' : ` transform="${mat(c.m)}"`;
        const rule = c.shape.eo ? ' clip-rule="evenodd" fill-rule="evenodd"' : '';
        cover = c.shape.parts.map((p) => `<path d="${p.d}"${t}${rule}/>`).join('');
        if (!c.invert) {
          const id = this.id('c');
          this.defs.push(`<clipPath id="${id}">${cover}</clipPath>`);
          out = `<g clip-path="url(#${id})">${out}</g>`;
          continue;
        }
      } else cover = this.rb(c.mask);
      out = this.compose(out, cover, c.invert ? 23 : 18);
    }
    if (e.alpha !== undefined && e.alpha < 1) out = `<g opacity="${num(e.alpha)}">${out}</g>`;
    if (e.blend) {
      const mode = BLEND[e.blend];
      if (mode) out = `<g style="mix-blend-mode:${mode}">${out}</g>`;
      else this.warn(`rb blend ${e.blend} unsupported`);
    }
    return out;
  }

  private rbItem(it: NonNullable<RBEntry['item']>, list: RBList, tint?: RGBA): string {
    const t = isIdentity(it.m) ? '' : ` transform="${mat(it.m)}"`;
    const s = it.shape;
    if (it.paint.kind === 'image' && s.kind === 'path') return `<g${t}>${this.rbImageFill(it.paint, s.parts, list, tint)}</g>`;
    const fill = tint ? colorAttrs(tint) : this.rbPaint(it.paint);
    switch (s.kind) {
      case 'path':
        if (s.badOp !== undefined) this.warn(`path op ${s.badOp} unsupported`);
        return `<g${t}>${this.parts(s.parts, fill, s.eo)}</g>`;
      case 'fill':
        return `<rect x="-4000" y="-4000" width="8000" height="8000" ${fill}${t}/>`;
      case 'glyphs': {
        const res = list.resources.get(s.font)?.font;
        if (!res) {
          this.warn(`glyph font ${s.font} missing`);
          return '';
        }
        let font: Font | undefined;
        // glyph ids of a system font we could not verify are meaningless here, but the enclosing accessibility label
        // names the characters when it has one per glyph: draw those from the installed font at the archived positions
        let byChar: string[] | undefined;
        if (res.kind === 'embedded') {
          font = this.a.font(res.chunk);
          if (!font) this.warn(`font chunk ${res.chunk} unreadable`);
        } else {
          const sys = this.a.systemFont(res.chunk);
          font = sys.font;
          const label = [...(this.labelStack.at(-1) ?? '')];
          if (!font && sys.unverified?.glyphFor && label.length === s.glyphs.length && label.every((ch) => /\s/.test(ch) || sys.unverified!.glyphFor!(ch) !== undefined)) {
            font = sys.unverified;
            byChar = label;
          } else if (!font && !s.placeholder && !(s.glyphs.length && s.glyphs.every((g) => this.placeholderGids(list, s.font).has(g.gid))))
            this.warn(`system font ${sys.family} not drawn: ${sys.reason}`);
        }
        // a run made only of glyphs that flagged placeholder runs of the same font use is a placeholder too
        const isPlaceholder = s.placeholder || (s.glyphs.length > 0 && s.glyphs.every((g) => this.placeholderGids(list, s.font).has(g.gid)));
        if (!font && isPlaceholder && s.glyphs.length) {
          // a redaction placeholder run in a font we cannot draw: its glyphs only ever make one rounded bar, so draw
          // the bar SF's placeholder glyph (U+100BB7) outlines, in em: 0.705 tall from the baseline, 0.488 per segment
          const len = Math.max(...s.glyphs.map((g) => g.x)) + PLACEHOLDER_SEGMENT_EM;
          const c = tint ?? (it.paint.kind === 'color' ? it.paint.color : undefined);
          const fillAttr = c ? colorAttrs(c) : fill;
          return `<rect${t} width="${num(len)}" height="${PLACEHOLDER_BAR_HEIGHT_EM}" rx="${PLACEHOLDER_BAR_RADIUS_EM}" ${fillAttr}/>`;
        }
        if (!font) return '';
        const k = 1 / font.unitsPerEm;
        let text = '';
        const drawFont = font;
        const uses = s.glyphs
          .map((g, gi) => {
            const fromSource = this.chars && this.charSource ? this.charSource[this.charPos++] : undefined;
            // a glyph outside the embedded subset is an original id the subsetter left alone
            const stray = !byChar && res.kind === 'embedded' && g.gid >= drawFont.numGlyphs ? this.a.missingGlyph(res.chunk, g.gid) : undefined;
            const ch = byChar ? byChar[gi] : (fromSource ?? (stray ? stray.font.charFor(stray.gid) : drawFont.charFor(g.gid)));
            const gid = byChar ? (/\s/.test(ch ?? ' ') ? -1 : (drawFont.glyphFor?.(ch!) ?? -1)) : g.gid;
            text += ch ?? '\ufffd';
            const wrap = (use: string) => {
              if (!this.chars || !ch || !use) return use;
              const i = this.chars.length;
              this.chars.push(ch);
              return `<g data-la-ch="${esc(ch)}" data-la-i="${i}">${use}</g>`;
            };
            const key = stray ? stray.key : `${res.chunk}:${byChar ? 'c' : ''}${gid}`;
            let id = this.glyphs.get(key);
            if (id === undefined) {
              const d = stray ? stray.font.glyphPath(stray.gid) : gid >= 0 ? drawFont.glyphPath(gid) : '';
              id = d ? this.id('gl') : '';
              if (d) this.defs.push(`<path id="${id}" d="${d}"/>`);
              this.glyphs.set(key, id);
            }
            if (!id && ch && this.chars) this.chars.push(ch); // spaces keep their index
            return wrap(id ? `<use href="#${id}" transform="translate(${num(g.x)} 0) scale(${stray ? 1 / stray.font.unitsPerEm : k})"/>` : '');
          })
          .join('');
        this.runs.push({ text, x: it.m[4], y: it.m[5] });
        // run alpha applies to the run as a layer so overlapping glyphs (placeholder bars) do not stack
        const c = tint ?? (it.paint.kind === 'color' ? it.paint.color : undefined);
        if (c && c[3] < 1) return `<g${t} ${colorAttrs([c[0], c[1], c[2], 1])} opacity="${num(clamp01(c[3]))}">${uses}</g>`;
        return `<g${t} ${fill}>${uses}</g>`;
      }
      case 'unknown':
        this.warn(`rb shape ${s.field} unsupported`);
        return '';
    }
  }

  // glyph ids the placeholder-flagged runs of one font resource use, across the list and its groups
  private placeholderCache = new Map<RBList['resources'], Map<number, Set<number>>>();
  private placeholderGids(list: RBList, font: number): Set<number> {
    let byFont = this.placeholderCache.get(list.resources);
    if (!byFont) {
      byFont = new Map();
      const walk = (l: RBList) => {
        for (const e of l.entries) {
          const sh = e.item?.shape;
          if (sh?.kind === 'glyphs' && sh.placeholder) {
            const set = byFont!.get(sh.font) ?? new Set<number>();
            for (const g of sh.glyphs) set.add(g.gid);
            byFont!.set(sh.font, set);
          }
          if (e.group) walk(e.group);
        }
      };
      walk(this.rbRoots.get(list.resources) ?? list);
      this.placeholderCache.set(list.resources, byFont);
    }
    return byFont.get(font) ?? new Set();
  }

  // runs of one drawing become one string: same baseline joins left to right, new baselines start a line
  private collectText(first: number) {
    const runs = this.runs.splice(first);
    // runs whose baselines are within 2 pt share a line (a slash or a unit can sit a little higher)
    const lines = new Map<number, typeof runs>();
    for (const r of [...runs].sort((a, b) => a.y - b.y)) {
      const k = [...lines.keys()].find((y) => Math.abs(y - r.y) <= 2) ?? r.y;
      lines.set(k, [...(lines.get(k) ?? []), r]);
    }
    const text = [...lines.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, rs]) => rs.sort((a, b) => a.x - b.x).map((r) => r.text).join(''))
      .join('\n')
      .trim();
    const label = this.labelStack.at(-1);
    if (text && !text.includes('\ufffd')) this.texts.push(text);
    else if (runs.length && label) this.texts.push(label);
  }

  // image paint: clip to the shape and draw the bitmap over the unit square mapped by the paint transform
  // a template tint keeps the bitmap's coverage and replaces its colour
  private rbImageFill(p: Extract<RBPaint, { kind: 'image' }>, parts: PathPart[], list: RBList, tint?: RGBA): string {
    const chunk = list.resources.get(p.resource)?.image;
    const web = chunk !== undefined ? webImage(this.a.chunk(chunk)) : undefined;
    const b = web?.bytes;
    const mime = web?.mime;
    if (!b || !mime) {
      this.warn('rb image paint without a decodable image');
      return '';
    }
    const id = this.id('c');
    this.defs.push(`<clipPath id="${id}">${parts.map((q) => `<path d="${q.d}"/>`).join('')}</clipPath>`);
    const op = p.color && p.color[3] < 1 ? ` opacity="${num(clamp01(p.color[3]))}"` : '';
    const m = mat(p.m);
    let filter = '';
    if (tint) {
      const fid = this.id('t');
      this.defs.push(`<filter id="${fid}" color-interpolation-filters="sRGB"><feFlood ${colorAttrs(tint, 'flood-color')}/><feComposite in2="SourceGraphic" operator="in"/></filter>`);
      filter = ` filter="url(#${fid})"`;
    }
    return (
      `<g clip-path="url(#${id})"${op}><image width="1" height="1" preserveAspectRatio="none" transform="${m}"${filter}` +
      ` href="data:${mime};base64,${base64(b)}"/></g>`
    );
  }

  private rbPaint(p: RBPaint): string {
    switch (p.kind) {
      case 'image':
        this.warn('rb image paint on a non-path shape unsupported');
        return 'fill="none"';
      case 'color':
        return colorAttrs(p.color);
      case 'linear':
        return this.gradient('linear', p.stops, `x1="${num(p.from.x)}" y1="${num(p.from.y)}" x2="${num(p.to.x)}" y2="${num(p.to.y)}"`);
      case 'unknown':
        this.warn(`rb paint ${p.field} unsupported`);
        return 'fill="#808080"';
    }
  }
}

