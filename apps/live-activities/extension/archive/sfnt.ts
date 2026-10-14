// truetype / cff subset reader: glyph outlines as svg path data (font units, y up) and a reverse cmap

import { parseCFF } from './cff';

export type Font = {
  name: string;
  version?: string; // name table id 3, for example '.SF NS; 21.4d2e1; 2026-01-14'
  unitsPerEm: number;
  numGlyphs: number;
  glyphPath(gid: number): string; // '' for empty glyphs
  charFor(gid: number): string | undefined;
  bytes: Uint8Array;
};

// coords: variation axis values in user units keyed by tag (wght, opsz...); applied through avar and gvar
export function parseFont(bytes: Uint8Array, name = '', coords?: Record<string, number>): Font {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // bare cff (major version 1, header size 4)
  if (bytes[0] === 1 && bytes[1] === 0 && bytes[2] === 4) {
    const c = parseCFF(bytes);
    const cache = new Map<number, string>();
    return { name, bytes, unitsPerEm: c.unitsPerEm, numGlyphs: c.numGlyphs, charFor: () => undefined, glyphPath: (g) => cache.get(g) ?? (cache.set(g, c.glyphPath(g)), cache.get(g)!) };
  }
  const n = dv.getUint16(4);
  const tables = new Map<string, [number, number]>();
  for (let i = 0; i < n; i++) {
    const r = 12 + 16 * i;
    const tag = String.fromCharCode(...bytes.subarray(r, r + 4));
    tables.set(tag, [dv.getUint32(r + 8), dv.getUint32(r + 12)]);
  }
  const head = tables.get('head');
  const maxp = tables.get('maxp');
  if (!head || !maxp) throw new Error('sfnt missing head/maxp');
  const unitsPerEm = dv.getUint16(head[0] + 18);
  const longLoca = dv.getInt16(head[0] + 50) === 1;
  const numGlyphs = dv.getUint16(maxp[0] + 4);
  const loca = tables.get('loca');
  const glyf = tables.get('glyf');
  const cache = new Map<number, string>();
  const rev = reverseCmap(bytes, dv, tables.get('cmap'));
  const version = nameString(bytes, dv, tables.get('name'), 3);
  const norm = coords ? normalizedCoords(dv, tables, coords) : undefined;
  const gvar = norm?.some((v) => v) ? tables.get('gvar') : undefined;
  const cffT = tables.get('CFF ');
  if (!glyf && cffT) {
    const c = parseCFF(bytes.subarray(cffT[0], cffT[0] + cffT[1]));
    return { name, bytes, unitsPerEm, numGlyphs, charFor: (g) => rev.get(g), glyphPath: (g) => cache.get(g) ?? (cache.set(g, c.glyphPath(g)), cache.get(g)!) };
  }

  const glyphRange = (gid: number): [number, number] | undefined => {
    if (!loca || !glyf || gid < 0 || gid >= numGlyphs) return undefined;
    const at = (i: number) => (longLoca ? dv.getUint32(loca[0] + 4 * i) : dv.getUint16(loca[0] + 2 * i) * 2);
    const s = at(gid);
    const e = at(gid + 1);
    return e > s ? [glyf[0] + s, glyf[0] + e] : undefined;
  };

  // contours as point lists so composites can transform them
  type Pt = { x: number; y: number; on: boolean };
  const contours = (gid: number, depth: number): Pt[][] => {
    const r = glyphRange(gid);
    if (!r || depth > 8) return [];
    let p = r[0];
    const nc = dv.getInt16(p);
    p += 10;
    if (nc >= 0) {
      const ends: number[] = [];
      for (let i = 0; i < nc; i++, p += 2) ends.push(dv.getUint16(p));
      const np = nc ? ends[nc - 1]! + 1 : 0;
      p += 2 + dv.getUint16(p);
      const flags: number[] = [];
      while (flags.length < np) {
        const f = bytes[p++]!;
        flags.push(f);
        if (f & 8) for (let k = bytes[p++]!; k > 0; k--) flags.push(f);
      }
      const coord = (short: number, same: number) => {
        const out: number[] = [];
        let v = 0;
        for (const f of flags) {
          if (f & short) {
            const d = bytes[p++]!;
            v += f & same ? d : -d;
          } else if (!(f & same)) {
            v += dv.getInt16(p);
            p += 2;
          }
          out.push(v);
        }
        return out;
      };
      const xs = coord(2, 16);
      const ys = coord(4, 32);
      if (gvar && norm) applyGvar(dv, gvar[0], gid, norm, xs, ys, ends);
      const out: Pt[][] = [];
      let s = 0;
      for (const e of ends) {
        const c: Pt[] = [];
        for (let i = s; i <= e; i++) c.push({ x: xs[i]!, y: ys[i]!, on: (flags[i]! & 1) === 1 });
        out.push(c);
        s = e + 1;
      }
      return out;
    }
    const out: Pt[][] = [];
    for (;;) {
      const f = dv.getUint16(p);
      const g = dv.getUint16(p + 2);
      p += 4;
      let dx = 0;
      let dy = 0;
      if (f & 1) {
        dx = dv.getInt16(p);
        dy = dv.getInt16(p + 2);
        p += 4;
      } else {
        dx = dv.getInt8(p);
        dy = dv.getInt8(p + 1);
        p += 2;
      }
      let [a, b, c, d] = [1, 0, 0, 1];
      const f2 = (o: number) => dv.getInt16(o) / 16384;
      if (f & 8) {
        a = d = f2(p);
        p += 2;
      } else if (f & 0x40) {
        a = f2(p);
        d = f2(p + 2);
        p += 4;
      } else if (f & 0x80) {
        [a, b, c, d] = [f2(p), f2(p + 2), f2(p + 4), f2(p + 6)];
        p += 8;
      }
      // point-matching offsets (args are point indices) are rare in subsets; treat as zero
      if (!(f & 2)) dx = dy = 0;
      for (const cont of contours(g, depth + 1))
        out.push(cont.map((q) => ({ x: a * q.x + c * q.y + dx, y: b * q.x + d * q.y + dy, on: q.on })));
      if (!(f & 0x20)) break;
    }
    return out;
  };

  const toPath = (cs: Pt[][]) => {
    const r = (v: number) => +v.toFixed(1);
    let d = '';
    for (const c of cs) {
      if (!c.length) continue;
      // start on an on-curve point, synthesising one between two off-curve points
      let start = c.findIndex((q) => q.on);
      const pts = start < 0 ? c : [...c.slice(start), ...c.slice(0, start)];
      const first = start < 0 ? { x: (c[0]!.x + c[1 % c.length]!.x) / 2, y: (c[0]!.y + c[1 % c.length]!.y) / 2, on: true } : pts[0]!;
      d += `M${r(first.x)} ${r(first.y)}`;
      const seq = start < 0 ? [...pts, pts[0]!] : [...pts.slice(1), pts[0]!];
      let ctrl: Pt | undefined;
      for (const q of seq) {
        if (q.on) {
          d += ctrl ? `Q${r(ctrl.x)} ${r(ctrl.y)} ${r(q.x)} ${r(q.y)}` : `L${r(q.x)} ${r(q.y)}`;
          ctrl = undefined;
        } else {
          if (ctrl) {
            const mx = (ctrl.x + q.x) / 2;
            const my = (ctrl.y + q.y) / 2;
            d += `Q${r(ctrl.x)} ${r(ctrl.y)} ${r(mx)} ${r(my)}`;
          }
          ctrl = q;
        }
      }
      if (ctrl) d += `Q${r(ctrl.x)} ${r(ctrl.y)} ${r(first.x)} ${r(first.y)}`;
      d += 'Z';
    }
    return d;
  };

  return {
    name,
    version,
    unitsPerEm,
    numGlyphs,
    bytes,
    glyphPath(gid) {
      let d = cache.get(gid);
      if (d === undefined) {
        try {
          d = toPath(contours(gid, 0));
        } catch {
          d = '';
        }
        cache.set(gid, d);
      }
      return d;
    },
    charFor: (gid) => rev.get(gid),
  };
}

function nameString(bytes: Uint8Array, dv: DataView, t: [number, number] | undefined, id: number): string | undefined {
  if (!t) return undefined;
  const count = dv.getUint16(t[0] + 2);
  const str = t[0] + dv.getUint16(t[0] + 4);
  for (let i = 0; i < count; i++) {
    const r = t[0] + 6 + 12 * i;
    if (dv.getUint16(r + 6) !== id) continue;
    const [pid, len, off] = [dv.getUint16(r), dv.getUint16(r + 8), str + dv.getUint16(r + 10)];
    if (pid === 3 || pid === 0) {
      let out = '';
      for (let k = 0; k < len; k += 2) out += String.fromCharCode(dv.getUint16(off + k));
      return out;
    }
    if (pid === 1) return String.fromCharCode(...bytes.subarray(off, off + len));
  }
  return undefined;
}

// user coords -> normalized [-1, 1] per fvar axis, then through avar segment maps
function normalizedCoords(dv: DataView, tables: Map<string, [number, number]>, coords: Record<string, number>): number[] | undefined {
  const fvar = tables.get('fvar');
  if (!fvar) return undefined;
  const base = fvar[0];
  const axesOff = base + dv.getUint16(base + 4);
  const count = dv.getUint16(base + 8);
  const size = dv.getUint16(base + 10);
  const fx = (o: number) => dv.getInt32(o) / 65536;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const a = axesOff + i * size;
    const tag = String.fromCharCode(dv.getUint8(a), dv.getUint8(a + 1), dv.getUint8(a + 2), dv.getUint8(a + 3));
    const [min, def, max] = [fx(a + 4), fx(a + 8), fx(a + 12)];
    const v = Math.min(max, Math.max(min, coords[tag] ?? def));
    out.push(v < def ? (def === min ? 0 : (v - def) / (def - min)) : v > def ? (max === def ? 0 : (v - def) / (max - def)) : 0);
  }
  const avar = tables.get('avar');
  if (avar) {
    let p = avar[0] + 8;
    for (let i = 0; i < Math.min(count, dv.getUint16(avar[0] + 6)); i++) {
      const n = dv.getUint16(p);
      const maps: [number, number][] = [];
      for (let k = 0; k < n; k++) maps.push([dv.getInt16(p + 2 + 4 * k) / 16384, dv.getInt16(p + 4 + 4 * k) / 16384]);
      p += 2 + 4 * n;
      const v = out[i]!;
      for (let k = 1; k < maps.length; k++) {
        const [a0, b0] = maps[k - 1]!;
        const [a1, b1] = maps[k]!;
        if (v <= a1) {
          out[i] = a1 === a0 ? b0 : b0 + ((v - a0) * (b1 - b0)) / (a1 - a0);
          break;
        }
      }
    }
  }
  return out;
}

// applies gvar deltas to a simple glyph in place (phantom points ignored, unreferenced points interpolated)
function applyGvar(dv: DataView, base: number, gid: number, norm: number[], xs: number[], ys: number[], ends: number[]) {
  const axisCount = dv.getUint16(base + 4);
  const sharedCount = dv.getUint16(base + 6);
  const sharedOff = base + dv.getUint32(base + 8);
  const glyphCount = dv.getUint16(base + 12);
  const longOffsets = dv.getUint16(base + 14) & 1;
  const dataOff = base + dv.getUint32(base + 16);
  if (gid >= glyphCount) return;
  const off = (i: number) => (longOffsets ? dv.getUint32(base + 20 + 4 * i) : dv.getUint16(base + 20 + 2 * i) * 2);
  const start = dataOff + off(gid);
  if (off(gid + 1) <= off(gid)) return;
  const np = xs.length;
  const total = np + 4;
  const tuple = (o: number) => Array.from({ length: axisCount }, (_, i) => dv.getInt16(o + 2 * i) / 16384);
  const shared = Array.from({ length: sharedCount }, (_, i) => tuple(sharedOff + 2 * axisCount * i));

  let p = 0;
  const readPoints = (): number[] | undefined => {
    let n = dv.getUint8(p++);
    if (n & 0x80) n = ((n & 0x7f) << 8) | dv.getUint8(p++);
    if (!n) return undefined; // all points
    const pts: number[] = [];
    let last = 0;
    while (pts.length < n) {
      const c = dv.getUint8(p++);
      const words = c & 0x80;
      for (let k = 0; k <= (c & 0x7f) && pts.length < n; k++) {
        last += words ? dv.getUint16((p += 2) - 2) : dv.getUint8(p++);
        pts.push(last);
      }
    }
    return pts;
  };
  const readDeltas = (n: number): number[] => {
    const out: number[] = [];
    while (out.length < n) {
      const c = dv.getUint8(p++);
      const cnt = (c & 0x3f) + 1;
      for (let k = 0; k < cnt && out.length < n; k++) {
        if (c & 0x80) out.push(0);
        else if (c & 0x40) out.push(dv.getInt16((p += 2) - 2));
        else out.push(dv.getInt8(p++));
      }
    }
    return out;
  };

  const header = dv.getUint16(start);
  const count = header & 0x0fff;
  p = start + dv.getUint16(start + 2);
  const sharedPts = header & 0x8000 ? readPoints() : undefined;
  let h = start + 4;
  const dx = new Float64Array(np);
  const dy = new Float64Array(np);
  for (let t = 0; t < count; t++) {
    const size = dv.getUint16(h);
    const idx = dv.getUint16(h + 2);
    h += 4;
    let peak: number[];
    if (idx & 0x8000) {
      peak = tuple(h);
      h += 2 * axisCount;
    } else peak = shared[idx & 0x0fff] ?? [];
    let lo: number[] | undefined;
    let hi: number[] | undefined;
    if (idx & 0x4000) {
      lo = tuple(h);
      hi = tuple(h + 2 * axisCount);
      h += 4 * axisCount;
    }
    const dataStart = p;
    let scalar = 1;
    for (let i = 0; i < axisCount && scalar; i++) {
      const pk = peak[i] ?? 0;
      const v = norm[i] ?? 0;
      if (!pk) continue;
      const a = lo ? lo[i]! : Math.min(0, pk);
      const b = hi ? hi[i]! : Math.max(0, pk);
      if (v < a || v > b) scalar = 0;
      else if (v === pk) continue;
      else scalar *= v < pk ? (pk === a ? 1 : (v - a) / (pk - a)) : pk === b ? 1 : (b - v) / (b - pk);
    }
    if (scalar) {
      const pts = idx & 0x2000 ? readPoints() : sharedPts;
      const n = pts ? pts.length : total;
      const xd = readDeltas(n);
      const yd = readDeltas(n);
      const tx = new Float64Array(np);
      const ty = new Float64Array(np);
      const touched = new Uint8Array(np);
      for (let k = 0; k < n; k++) {
        const pi = pts ? pts[k]! : k;
        if (pi >= np) continue;
        tx[pi] = xd[k]!;
        ty[pi] = yd[k]!;
        touched[pi] = 1;
      }
      if (pts) iup(xs, ys, ends, tx, ty, touched);
      for (let i = 0; i < np; i++) {
        dx[i] = dx[i]! + tx[i]! * scalar;
        dy[i] = dy[i]! + ty[i]! * scalar;
      }
    }
    p = dataStart + size;
  }
  for (let i = 0; i < np; i++) {
    xs[i] = xs[i]! + dx[i]!;
    ys[i] = ys[i]! + dy[i]!;
  }
}

// interpolate deltas for untouched points from their touched neighbours on the same contour
function iup(xs: number[], ys: number[], ends: number[], dx: Float64Array, dy: Float64Array, touched: Uint8Array) {
  let s = 0;
  for (const e of ends) {
    const idx: number[] = [];
    for (let i = s; i <= e; i++) if (touched[i]) idx.push(i);
    if (idx.length) {
      for (let k = 0; k < idx.length; k++) {
        const a = idx[k]!;
        const b = idx[(k + 1) % idx.length]!;
        for (let i = a + 1; ; i++) {
          const j = i > e ? s + (i - e - 1) : i;
          if (j === b) break;
          for (const [c, d] of [[xs, dx], [ys, dy]] as const) {
            const [ca, cb] = [c[a]!, c[b]!];
            const [da, db] = [d[a]!, d[b]!];
            const v = c[j]!;
            if (ca === cb) d[j] = da === db ? da : 0;
            else if (v <= Math.min(ca, cb)) d[j] = ca < cb ? da : db;
            else if (v >= Math.max(ca, cb)) d[j] = ca > cb ? da : db;
            else d[j] = da + ((v - ca) * (db - da)) / (cb - ca);
          }
          if (i > e + (e - s + 1)) break;
        }
      }
    }
    s = e + 1;
  }
}

// subsets carry a mac roman (format 6) or unicode cmap; prefer unicode subtables
function reverseCmap(bytes: Uint8Array, dv: DataView, t: [number, number] | undefined): Map<number, string> {
  const out = new Map<number, string>();
  if (!t) return out;
  const base = t[0];
  const n = dv.getUint16(base + 2);
  const subs: { pid: number; eid: number; off: number }[] = [];
  for (let i = 0; i < n; i++)
    subs.push({ pid: dv.getUint16(base + 4 + 8 * i), eid: dv.getUint16(base + 6 + 8 * i), off: base + dv.getUint32(base + 8 + 8 * i) });
  subs.sort((a, b) => Number(b.pid === 0 || b.pid === 3) - Number(a.pid === 0 || a.pid === 3));
  for (const s of subs) {
    const mac = s.pid === 1;
    const put = (code: number, gid: number) => {
      if (gid && !out.has(gid)) out.set(gid, mac ? macRoman(code) : String.fromCodePoint(code));
    };
    const fmt = dv.getUint16(s.off);
    if (fmt === 0) for (let c = 0; c < 256; c++) put(c, bytes[s.off + 6 + c]!);
    else if (fmt === 6) {
      const first = dv.getUint16(s.off + 6);
      const count = dv.getUint16(s.off + 8);
      for (let i = 0; i < count; i++) put(first + i, dv.getUint16(s.off + 10 + 2 * i));
    } else if (fmt === 4) {
      const segs = dv.getUint16(s.off + 6) / 2;
      const ends = s.off + 14;
      const starts = ends + 2 * segs + 2;
      const deltas = starts + 2 * segs;
      const ranges = deltas + 2 * segs;
      for (let i = 0; i < segs; i++) {
        const e = dv.getUint16(ends + 2 * i);
        const st = dv.getUint16(starts + 2 * i);
        const delta = dv.getInt16(deltas + 2 * i);
        const ro = dv.getUint16(ranges + 2 * i);
        for (let c = st; c <= e && c !== 0xffff; c++) {
          let g: number;
          if (!ro) g = (c + delta) & 0xffff;
          else {
            const gi = ranges + 2 * i + ro + 2 * (c - st);
            g = dv.getUint16(gi);
            if (g) g = (g + delta) & 0xffff;
          }
          put(c, g);
        }
      }
    } else if (fmt === 12) {
      const groups = dv.getUint32(s.off + 12);
      for (let i = 0; i < groups; i++) {
        const g = s.off + 16 + 12 * i;
        const sc = dv.getUint32(g);
        const ec = dv.getUint32(g + 4);
        const sg = dv.getUint32(g + 8);
        for (let c = sc; c <= ec && c - sc < 65536; c++) put(c, sg + c - sc);
      }
    }
  }
  return out;
}

const MAC_HIGH =
  'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';
const macRoman = (c: number) => (c < 128 ? String.fromCharCode(c) : (MAC_HIGH[c - 128] ?? '�'));
