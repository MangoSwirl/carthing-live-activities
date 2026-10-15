// builds a tiny static truetype font from instanced outlines, for @font-face on devices without sf fonts.
// only what browsers' sanitisers require: head hhea maxp os/2 hmtx cmap loca glyf name post

import type { Contour, Font } from './sfnt';

export function buildSubset(font: Font, chars: string[], family: string, weight: number, glyphOf: (ch: string) => number | undefined): Uint8Array | undefined {
  if (!font.advance || !font.contours || !font.metrics) return undefined;
  const glyphs: { ch?: string; contours: Contour[]; adv: number }[] = [{ contours: [], adv: Math.round(font.unitsPerEm / 2) }];
  for (const ch of chars) {
    const g = glyphOf(ch);
    if (g === undefined) continue;
    glyphs.push({ ch, contours: font.contours(g), adv: Math.round(font.advance(g)) });
  }
  if (glyphs.length < 2) return undefined;

  // glyf: simple glyphs with explicit int16 coordinates
  const glyf: number[] = [];
  const loca: number[] = [0];
  const boxes: [number, number, number, number][] = [];
  for (const g of glyphs) {
    const pts = g.contours.flat().map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), on: p.on }));
    if (!pts.length) {
      boxes.push([0, 0, 0, 0]);
      loca.push(glyf.length);
      continue;
    }
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const box: [number, number, number, number] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    boxes.push(box);
    const w = new Writer();
    w.i16(g.contours.length);
    box.forEach((v) => w.i16(v));
    let end = -1;
    for (const c of g.contours) w.u16((end += c.length));
    w.u16(0);
    for (const p of pts) w.u8(p.on ? 1 : 0);
    let last = 0;
    for (const p of pts) w.i16(p.x - last), (last = p.x);
    last = 0;
    for (const p of pts) w.i16(p.y - last), (last = p.y);
    while (w.bytes.length % 4) w.u8(0);
    glyf.push(...w.bytes);
    loca.push(glyf.length);
  }
  const n = glyphs.length;
  const all = boxes.filter((b) => b[2] > b[0]);
  const bbox = [Math.min(...all.map((b) => b[0])), Math.min(...all.map((b) => b[1])), Math.max(...all.map((b) => b[2])), Math.max(...all.map((b) => b[3]))];
  const { ascender, descender, lineGap } = font.metrics;
  const maxAdv = Math.max(...glyphs.map((g) => g.adv));

  const head = new Writer();
  head.u32(0x00010000).u32(0x00010000).u32(0).u32(0x5f0f3cf5).u16(0).u16(font.unitsPerEm);
  head.u32(0).u32(0).u32(0).u32(0);
  bbox.forEach((v) => head.i16(v!));
  head.u16(weight >= 600 ? 1 : 0).u16(8).i16(2).i16(1).i16(0);

  const hhea = new Writer();
  hhea.u32(0x00010000).i16(ascender).i16(descender).i16(lineGap).u16(maxAdv).i16(bbox[0]!).i16(0).i16(bbox[2]!);
  hhea.i16(1).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).u16(n);

  const maxp = new Writer();
  maxp.u32(0x00010000).u16(n).u16(Math.max(...glyphs.map((g) => g.contours.flat().length), 1)).u16(Math.max(...glyphs.map((g) => g.contours.length), 1));
  maxp.u16(0).u16(0).u16(2).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0);

  const os2 = new Writer();
  os2.u16(4).i16(Math.round(maxAdv / 2)).u16(weight).u16(5).u16(0);
  for (let i = 0; i < 10; i++) os2.i16(0); // sub/superscript, strikeout metrics
  os2.i16(0);
  for (let i = 0; i < 10; i++) os2.u8(0); // panose
  os2.u32(1).u32(0).u32(0).u32(0); // unicode ranges: basic latin
  os2.u32(0x2020_2020); // vendor
  const codes = glyphs.slice(1).map((g) => g.ch!.codePointAt(0)!);
  os2.u16(weight >= 600 ? 0x20 : 0x40).u16(Math.min(...codes)).u16(Math.max(...codes));
  os2.i16(ascender).i16(descender).i16(lineGap).u16(Math.max(ascender, bbox[3]!)).u16(Math.max(-descender, -bbox[1]!));
  os2.u32(1).u32(0).i16(0).i16(0).u16(0).u16(32).u16(0);

  const hmtx = new Writer();
  glyphs.forEach((g, i) => hmtx.u16(g.adv).i16(boxes[i]![0]));

  // cmap format 4, one segment per code
  const segs = glyphs.slice(1).map((g, i) => [g.ch!.codePointAt(0)!, i + 1] as const).sort((a, b) => a[0] - b[0]);
  segs.push([0xffff, 0]);
  const segX2 = segs.length * 2;
  const sub = new Writer();
  const log = Math.floor(Math.log2(segs.length));
  sub.u16(4).u16(16 + segs.length * 8).u16(0).u16(segX2).u16(2 * 2 ** log).u16(log).u16(segX2 - 2 * 2 ** log);
  segs.forEach(([c]) => sub.u16(c));
  sub.u16(0);
  segs.forEach(([c]) => sub.u16(c));
  segs.forEach(([c, g]) => sub.u16(c === 0xffff ? 1 : (g - c) & 0xffff));
  segs.forEach(() => sub.u16(0));
  const cmap = new Writer();
  cmap.u16(0).u16(1).u16(3).u16(1).u32(12).raw(sub.bytes);

  const nameRecs = [
    [1, family],
    [2, weight >= 600 ? 'Bold' : 'Regular'],
    [4, family],
    [6, family.replace(/[^A-Za-z0-9-]/g, '')],
  ] as const;
  const strs = nameRecs.map(([, v]) => [...v].flatMap((c) => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 255]));
  const name = new Writer();
  name.u16(0).u16(nameRecs.length).u16(6 + 12 * nameRecs.length);
  let off = 0;
  nameRecs.forEach(([id], i) => {
    name.u16(3).u16(1).u16(0x409).u16(id).u16(strs[i]!.length).u16(off);
    off += strs[i]!.length;
  });
  strs.forEach((b) => name.raw(b));

  const post = new Writer();
  post.u32(0x00030000).u32(0).i16(-100).i16(50).u32(0).u32(0).u32(0).u32(0).u32(0);

  const locaW = new Writer();
  loca.forEach((v) => locaW.u32(v));

  const tables: [string, number[]][] = [
    ['OS/2', os2.bytes],
    ['cmap', cmap.bytes],
    ['glyf', glyf],
    ['head', head.bytes],
    ['hhea', hhea.bytes],
    ['hmtx', hmtx.bytes],
    ['loca', locaW.bytes],
    ['maxp', maxp.bytes],
    ['name', name.bytes],
    ['post', post.bytes],
  ];
  const out = new Writer();
  const log2 = Math.floor(Math.log2(tables.length));
  out.u32(0x00010000).u16(tables.length).u16(16 * 2 ** log2).u16(log2).u16(tables.length * 16 - 16 * 2 ** log2);
  let at = 12 + 16 * tables.length;
  const body: number[] = [];
  for (const [tag, data] of tables) {
    const padded = [...data];
    while (padded.length % 4) padded.push(0);
    let sum = 0;
    for (let i = 0; i < padded.length; i += 4) sum = (sum + ((padded[i]! << 24) | (padded[i + 1]! << 16) | (padded[i + 2]! << 8) | padded[i + 3]!)) >>> 0;
    [...tag].forEach((c) => out.u8(c.charCodeAt(0)));
    out.u32(sum).u32(at).u32(data.length);
    body.push(...padded);
    at += padded.length;
  }
  out.raw(body);
  return new Uint8Array(out.bytes);
}

class Writer {
  bytes: number[] = [];
  u8(v: number) {
    this.bytes.push(v & 255);
    return this;
  }
  u16(v: number) {
    return this.u8(v >> 8).u8(v);
  }
  i16(v: number) {
    return this.u16(v & 0xffff);
  }
  u32(v: number) {
    return this.u16(v >>> 16).u16(v & 0xffff);
  }
  raw(b: number[]) {
    for (const v of b) this.bytes.push(v);
    return this;
  }
}
