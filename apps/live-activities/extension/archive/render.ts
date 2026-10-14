// display list -> self-contained svg (viewBox in points)

import type { Font } from './sfnt';
import { base64 } from './proto';
import {
  decodeFontDesc,
  decodeProgress,
  decodeState,
  type Progress,
  type Timer,
  type Transition,
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
};

export function pickState(a: Archive, opts: RenderOptions = {}): StateInfo | undefined {
  if (opts.stateIndex !== undefined) return a.states[opts.stateIndex];
  const tag = opts.viewTag ?? (a.viewTags.includes('listItem') ? 'listItem' : a.viewTags[0]);
  const want: Record<string, (v: any) => boolean> = {
    colorScheme: (v) => v === (opts.colorScheme ?? 'dark'),
    isLuminanceReduced: (v) => v === (opts.luminanceReduced ?? false),
    redactionReasons: (v) => v === (opts.redaction ?? 0),
    // full colour with the widget's own background
    widgetRenderScheme: (v) => v?.renderingMode?.mode === 0 && v?.backgroundViewPolicy === 0,
  };
  let best: StateInfo | undefined;
  let bestScore = -1;
  for (const s of a.states) {
    if (s.viewTag !== tag) continue;
    let score = s.entry === 0 ? 100 : 0;
    for (const [k, v] of Object.entries(s.env)) if (want[k]?.(v)) score += k === 'colorScheme' ? 4 : k === 'redactionReasons' ? 2 : 1;
    if (score > bestScore) [best, bestScore] = [s, score];
  }
  return best;
}

export function renderView(a: Archive, opts: RenderOptions = {}): RenderResult | null {
  const st = pickState(a, opts);
  if (!st) return null;
  const { size, nodes } = decodeState(a, st);
  const meta = st.metadata as { backgroundTintColor?: number[]; textColor?: number[] } | undefined;
  const textColor = rgba(meta?.textColor) ?? [0, 0, 0, 1];
  const r = new Renderer(a, opts.idPrefix ?? `v${fnv(a.chunk(st.chunk)).toString(36)}`, opts.now ?? Date.now(), textColor);
  const body = r.nodes(nodes);
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
    state: st,
  };
}

const num = (v: number) => String(+v.toFixed(3));
const rgba = (v: unknown): RGBA | undefined =>
  Array.isArray(v) && v.length >= 3 && v.every((x) => typeof x === "number") ? [v[0] as number, v[1] as number, v[2] as number, (v[3] as number | undefined) ?? 1] : undefined;

// ios system text metrics (sf pro): ascender and default line height in ems
const IOS_ASCENT = 0.952;
const IOS_LINE_HEIGHT = 1.193;
// ios linear ProgressView: 4pt capsule bar; the track is a system fill, not the tint (measured on device)
const IOS_PROGRESS_THICKNESS = 4;
const IOS_PROGRESS_TRACK: RGBA = [120 / 255, 120 / 255, 128 / 255, 0.25];

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

  nodes(ns: Node[]): string {
    return ns.map((n) => this.node(n)).join('');
  }

  node(n: Node): string {
    const { x, y } = n.frame;
    const at = (inner: string) => (inner && (x || y) ? `<g transform="translate(${num(x)} ${num(y)})">${inner}</g>` : inner);
    let out = '';
    const stable = n.id !== undefined ? this.a.stableId(n.id) : undefined;
    if (stable) this.stableKeys.push(stable);
    if (n.content) out += at(this.content(n.content, n.frame));
    if (n.effect) {
      // an enclosing accessibility label stands in for glyphs we cannot map back to characters
      const label = n.effect.kind === 'accessibility' && n.effect.label && (n.effect.traits ?? 0) & 256 ? n.effect.label : undefined;
      const tr = n.effect.kind === 'transition' ? n.effect.transition : undefined;
      if (label) this.labelStack.push(label);
      if (tr) this.transitions.push(tr);
      const inner = this.nodes(n.children ?? []);
      if (label) this.labelStack.pop();
      if (tr) this.transitions.pop();
      out += at(this.effect(n.effect, inner));
    }
    // interactive state lists: the first state is the resting one
    if (n.states?.length) out += at(this.nodes(n.states[0]!.children));
    if (stable) this.stableKeys.pop();
    return out;
  }

  private effect(e: Effect, inner: string): string {
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
        const fid = this.filter(e.filters);
        return fid ? `<g filter="url(#${fid})">${inner}</g>` : inner;
      }
      case 'blend': {
        const mode = BLEND[e.mode];
        if (e.mode === 0) return inner;
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

  private filter(fs: Filter[]): string | undefined {
    const prims: string[] = [];
    for (const f of fs) {
      switch (f.kind) {
        case 'blur':
          prims.push(`<feGaussianBlur stdDeviation="${num(f.radius / 2)}"/>`);
          break;
        case 'shadow':
          prims.push(`<feDropShadow dx="${num(f.dx)}" dy="${num(f.dy)}" stdDeviation="${num(f.radius / 2)}" ${colorAttrs(f.color, 'flood-color')}/>`);
          break;
        case 'matrix':
          prims.push(`<feColorMatrix type="matrix" values="${f.m.map(num).join(' ')}"/>`);
          break;
        case 'saturation':
          prims.push(`<feColorMatrix type="saturate" values="${num(f.v)}"/>`);
          break;
        case 'brightness':
          prims.push(`<feComponentTransfer>${['R', 'G', 'B'].map((c) => `<feFunc${c} type="linear" slope="1" intercept="${num(f.v)}"/>`).join('')}</feComponentTransfer>`);
          break;
        case 'multiply':
          prims.push(`<feColorMatrix type="matrix" values="${num(f.color[0])} 0 0 0 0 0 ${num(f.color[1])} 0 0 0 0 0 ${num(f.color[2])} 0 0 0 0 0 ${num(f.color[3])} 0"/>`);
          break;
        case 'luminanceToAlpha':
          prims.push('<feColorMatrix type="luminanceToAlpha"/>');
          break;
        default:
          this.warn(`filter ${f.field} unsupported`);
      }
    }
    if (!prims.length) return undefined;
    const id = this.id('f');
    this.defs.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">${prims.join('')}</filter>`);
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
        this.defs.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${num(c.radius / 2)}"/></filter>`);
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
          // stable across archive versions: the nearest stable identity, numbered per drawing beneath it
          const base = this.stableKeys.at(-1) ?? 'root';
          const n = this.keyUses.get(base) ?? 0;
          this.keyUses.set(base, n + 1);
          const key = n ? `${base}.${n}` : base;
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
        return '';
      }
      case 'backdrop':
        this.warn('backdrop blur approximated');
        return c.color ? `<rect width="${num(w)}" height="${num(h)}" ${colorAttrs(c.color)}/>` : '';
      case 'unknown':
        this.warn(`content ${c.field} unsupported`);
        return '';
    }
  }

  private text(c: Extract<Content, { kind: 'text' }>, w: number, h: number): string {
    const col = c.color ?? this.textColor;
    const chars = [...c.text];
    // redaction placeholders are runs of plane-16 private use characters drawn as a bar
    if (chars.length && chars.every((ch) => ch.codePointAt(0)! >= 0x100000)) {
      const bh = h * 0.7;
      return `<rect y="${num((h - bh) / 2)}" width="${num(w)}" height="${num(bh)}" rx="${num(bh / 4)}" ${colorAttrs(col)}/>`;
    }
    const font = c.fontChunk !== undefined && c.fontChunk >= 0 ? decodeFontDesc(this.a.chunk(c.fontChunk)) : undefined;
    if (!font?.size) this.warn('attributed text without a font descriptor');
    const size = font?.size || h / IOS_LINE_HEIGHT;
    const weight = font?.weight ?? 400;
    const family = (font?.rounded ? 'ui-rounded, "SF Pro Rounded", ' : '') + '-apple-system, "SF Pro", system-ui, sans-serif';
    const x = c.align === 'middle' ? w / 2 : c.align === 'end' ? w : 0;
    const y = (h - IOS_LINE_HEIGHT * size) / 2 + IOS_ASCENT * size;
    let value = c.text;
    let data = '';
    const t = c.timer;
    if (t && t.start !== undefined && t.end !== undefined) {
      value = t.style === 'timer' ? formatTimer(t, this.now) : c.text;
      data =
        ` data-la-timer-start="${Math.round(t.start)}" data-la-timer-end="${Math.round(t.end)}"` +
        ` data-la-timer-countdown="${t.countdown ? 1 : 0}" data-la-timer-style="${t.style}"`;
    }
    this.texts.push(value);
    const numeric = font?.monospacedDigits || c.tabular ? ' style="font-variant-numeric:tabular-nums"' : '';
    return (
      `<text x="${num(x)}" y="${num(y)}" font-family='${family}' font-size="${num(size)}" font-weight="${weight}"` +
      `${c.align !== 'start' ? ` text-anchor="${c.align}"` : ''} ${colorAttrs(col)}${numeric}${data}>${esc(value)}</text>`
    );
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
    switch (p.kind) {
      case 'color':
        return colorAttrs(p.color);
      case 'linear': {
        const [sx, sy] = p.units === 'unit' ? [frame.w, frame.h] : [1, 1];
        return this.gradient('linear', p.stops, `x1="${num(p.from.x * sx)}" y1="${num(p.from.y * sy)}" x2="${num(p.to.x * sx)}" y2="${num(p.to.y * sy)}"`);
      }
      case 'radial':
        return this.gradient('radial', p.stops, `cx="${num(p.center.x * frame.w)}" cy="${num(p.center.y * frame.h)}" r="${num(p.r1)}" fr="${num(p.r0)}"`);
      case 'angular': {
        // no conic gradients in svg; use the average colour
        this.warn('angular gradient approximated');
        const avg = [0, 1, 2, 3].map((i) => p.stops.reduce((s, x) => s + x.color[i]!, 0) / (p.stops.length || 1)) as RGBA;
        return colorAttrs(avg);
      }
      case 'unknown':
        this.warn(`paint ${p.field} unsupported`);
        return 'fill="#808080"';
    }
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
        const b = this.a.chunk(src.chunk);
        const mime = b[0] === 0x89 && b[1] === 0x50 ? 'image/png' : b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : undefined;
        if (!mime) {
          this.warn(`bitmap ${src.chunk} has unknown encoding`);
          return '';
        }
        let filter = '';
        if (img.tint) {
          const id = this.id('t');
          this.defs.push(`<filter id="${id}" color-interpolation-filters="sRGB"><feFlood ${colorAttrs(img.tint, 'flood-color')}/><feComposite in2="SourceGraphic" operator="in"/></filter>`);
          filter = ` filter="url(#${id})"`;
        }
        return `<image width="${num(w)}" height="${num(h)}" preserveAspectRatio="none"${filter} href="data:${mime};base64,${base64(b)}"/>`;
      }
      case 'none':
        return '';
    }
  }

  // ------------------------------------------------------------ renderbox lists

  private rb(list: RBList, tint?: RGBA): string {
    return list.entries.map((e) => this.rbEntry(e, list, tint)).join('');
  }

  private rbEntry(e: RBEntry, list: RBList, tint?: RGBA): string {
    let out = '';
    if (e.item) out += this.rbItem(e.item, list, tint);
    if (e.group) out += this.rb({ entries: e.group.entries, resources: list.resources }, tint);
    if (!out) return '';
    for (const c of (e.clip !== undefined ? list.resources.get(e.clip)?.clip : undefined) ?? []) {
      if (c.shape.kind !== 'path') continue;
      const id = this.id('c');
      const t = isIdentity(c.m) ? '' : ` transform="${mat(c.m)}"`;
      const rule = c.shape.eo ? ' clip-rule="evenodd"' : '';
      this.defs.push(`<clipPath id="${id}">${c.shape.parts.map((p) => `<path d="${p.d}"${t}${rule}/>`).join('')}</clipPath>`);
      out = `<g clip-path="url(#${id})">${out}</g>`;
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
    if (it.paint.kind === 'image' && !tint && s.kind === 'path') return `<g${t}>${this.rbImageFill(it.paint, s.parts, list)}</g>`;
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
        if (res.kind === 'embedded') {
          font = this.a.font(res.chunk);
          if (!font) this.warn(`font chunk ${res.chunk} unreadable`);
        } else {
          const sys = this.a.systemFont(res.chunk);
          font = sys.font;
          if (!font) this.warn(`system font ${sys.family} not drawn: ${sys.reason}`);
        }
        if (!font) return '';
        const k = 1 / font.unitsPerEm;
        let text = '';
        const uses = s.glyphs
          .map((g) => {
            const ch = this.chars && this.charSource ? this.charSource[this.charPos++] : font.charFor(g.gid);
            text += ch ?? '\ufffd';
            const wrap = (use: string) => {
              if (!this.chars || !ch || !use) return use;
              const i = this.chars.length;
              this.chars.push(ch);
              return `<g data-la-ch="${esc(ch)}" data-la-i="${i}">${use}</g>`;
            };
            const key = `${res.chunk}:${g.gid}`;
            let id = this.glyphs.get(key);
            if (id === undefined) {
              const d = font.glyphPath(g.gid);
              id = d ? this.id('gl') : '';
              if (d) this.defs.push(`<path id="${id}" d="${d}"/>`);
              this.glyphs.set(key, id);
            }
            if (!id && ch && this.chars) this.chars.push(ch); // spaces keep their index
            return wrap(id ? `<use href="#${id}" transform="translate(${num(g.x)} 0) scale(${k})"/>` : '');
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

  // runs of one drawing become one string: same baseline joins left to right, new baselines start a line
  private collectText(first: number) {
    const runs = this.runs.splice(first);
    const lines = new Map<number, typeof runs>();
    for (const r of runs) {
      const k = Math.round(r.y);
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
  private rbImageFill(p: Extract<RBPaint, { kind: 'image' }>, parts: PathPart[], list: RBList): string {
    const chunk = list.resources.get(p.resource)?.image;
    const b = chunk !== undefined ? this.a.chunk(chunk) : undefined;
    const mime = b && b[0] === 0x89 && b[1] === 0x50 ? 'image/png' : b && b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : undefined;
    if (!b || !mime) {
      this.warn('rb image paint without a decodable image');
      return '';
    }
    const id = this.id('c');
    this.defs.push(`<clipPath id="${id}">${parts.map((q) => `<path d="${q.d}"/>`).join('')}</clipPath>`);
    const op = p.color && p.color[3] < 1 ? ` opacity="${num(clamp01(p.color[3]))}"` : '';
    const m = mat(p.m);
    return (
      `<g clip-path="url(#${id})"${op}><image width="1" height="1" preserveAspectRatio="none" transform="${m}"` +
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

