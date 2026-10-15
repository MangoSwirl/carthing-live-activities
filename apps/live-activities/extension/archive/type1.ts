// postscript type 1 font reader (binary eexec section, type 1 charstrings): glyph outlines by glyph name.
// coregraphics embeds fonts it cannot subset as cff or truetype (e.g. pingfang) as type 1 subsets

export type Type1 = { name: string; unitsPerEm: number; encoding: string[]; glyphPath(name: string): string | undefined };

export function parseType1(b: Uint8Array): Type1 | undefined {
  const head = new TextDecoder('latin1').decode(b.subarray(0, Math.min(b.length, 64 * 1024)));
  if (!head.startsWith('%!')) return undefined;
  const at = head.indexOf('eexec');
  if (at < 0) return undefined;
  const clear = head.slice(0, at);
  const name = /\/FontName\s*\/(\S+)/.exec(clear)?.[1] ?? '';
  const scale = Number(/\/FontMatrix\s*\[\s*([\d.eE+-]+)/.exec(clear)?.[1] ?? 0.001);
  const encoding: string[] = [];
  for (const m of clear.matchAll(/dup\s+(\d+)\s*\/(\S+)\s+put/g)) encoding[Number(m[1])] = m[2]!;
  let start = at + 5;
  while (b[start] === 0x0d || b[start] === 0x0a || b[start] === 0x20 || b[start] === 0x09) start++;
  let body = b.subarray(start);
  // hex-encoded eexec sections (pfa) are rare in archives but cheap to accept
  if (body.length >= 4 && [...body.subarray(0, 4)].every((c) => /[0-9a-fA-F]/.test(String.fromCharCode(c)))) body = fromHex(body);
  const priv = decrypt(body, 55665, 4);
  const text = new TextDecoder('latin1').decode(priv);
  const lenIV = Number(/\/lenIV\s+(\d+)/.exec(text)?.[1] ?? 4);
  // binary strings follow "<n> RD " (or "-|"); slicing priv by offsets keeps the bytes exact
  const subrs: Uint8Array[] = [];
  const sub = /dup\s+(\d+)\s+(\d+)\s+(?:RD|-\|)\s/g;
  const charsAt = text.indexOf('/CharStrings');
  for (let m; (m = sub.exec(text)) && (charsAt < 0 || m.index < charsAt); ) {
    const n = Number(m[2]);
    const o = m.index + m[0].length;
    subrs[Number(m[1])] = decrypt(priv.subarray(o, o + n), 4330, lenIV);
    sub.lastIndex = o + n;
  }
  const glyphs = new Map<string, Uint8Array>();
  if (charsAt >= 0) {
    const cs = /\/([^\s/]+)\s+(\d+)\s+(?:RD|-\|)\s/g;
    cs.lastIndex = charsAt + 12;
    for (let m; (m = cs.exec(text)); ) {
      const n = Number(m[2]);
      const o = m.index + m[0].length;
      glyphs.set(m[1]!, decrypt(priv.subarray(o, o + n), 4330, lenIV));
      cs.lastIndex = o + n;
    }
  }
  const cache = new Map<string, string>();
  return {
    name,
    unitsPerEm: Math.round(1 / scale),
    encoding,
    glyphPath(g) {
      if (!cache.has(g)) {
        const code = glyphs.get(g);
        cache.set(g, code ? outline(code, subrs) : '');
      }
      return glyphs.has(g) ? cache.get(g) : undefined;
    },
  };
}

function fromHex(b: Uint8Array): Uint8Array {
  const s = new TextDecoder('latin1').decode(b).replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(s.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function decrypt(b: Uint8Array, r: number, skip: number): Uint8Array {
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) {
    const c = b[i]!;
    out[i] = c ^ (r >> 8);
    r = ((c + r) * 52845 + 22719) & 0xffff;
  }
  return out.subarray(Math.min(skip, out.length));
}

// type 1 charstring interpreter: svg path data in font units, y up
function outline(code: Uint8Array, subrs: Uint8Array[]): string {
  const r = (v: number) => +v.toFixed(1);
  let d = '';
  let x = 0;
  let y = 0;
  let open = false;
  const st: number[] = [];
  const ps: number[] = []; // postscript stack fed by callothersubr, drained by pop
  let flex: [number, number][] | undefined;
  const moveTo = (nx: number, ny: number) => {
    x = nx;
    y = ny;
    if (flex) return void flex.push([x, y]);
    if (open) d += 'Z';
    d += `M${r(x)} ${r(y)}`;
    open = true;
  };
  const lineTo = (nx: number, ny: number) => {
    x = nx;
    y = ny;
    d += `L${r(x)} ${r(y)}`;
  };
  const curveTo = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
    x = x3;
    y = y3;
    d += `C${r(x1)} ${r(y1)} ${r(x2)} ${r(y2)} ${r(x3)} ${r(y3)}`;
  };
  let depth = 0;
  const run = (c: Uint8Array): boolean => {
    if (++depth > 20) return true;
    for (let i = 0; i < c.length; ) {
      const v = c[i++]!;
      if (v >= 32) {
        if (v <= 246) st.push(v - 139);
        else if (v <= 250) st.push((v - 247) * 256 + c[i++]! + 108);
        else if (v <= 254) st.push(-(v - 251) * 256 - c[i++]! - 108);
        else {
          st.push(new DataView(c.buffer, c.byteOffset + i, 4).getInt32(0));
          i += 4;
        }
        continue;
      }
      const op = v === 12 ? 1200 + c[i++]! : v;
      switch (op) {
        case 13: // hsbw: side bearing x, advance
          x = st[0] ?? 0;
          y = 0;
          st.length = 0;
          break;
        case 1207: // sbw
          x = st[0] ?? 0;
          y = st[1] ?? 0;
          st.length = 0;
          break;
        case 21:
          moveTo(x + st[0]!, y + st[1]!);
          st.length = 0;
          break;
        case 22:
          moveTo(x + st[0]!, y);
          st.length = 0;
          break;
        case 4:
          moveTo(x, y + st[0]!);
          st.length = 0;
          break;
        case 5:
          lineTo(x + st[0]!, y + st[1]!);
          st.length = 0;
          break;
        case 6:
          lineTo(x + st[0]!, y);
          st.length = 0;
          break;
        case 7:
          lineTo(x, y + st[0]!);
          st.length = 0;
          break;
        case 8: {
          const [a, b, e, f, g, h] = st as [number, number, number, number, number, number];
          curveTo(x + a, y + b, x + a + e, y + b + f, x + a + e + g, y + b + f + h);
          st.length = 0;
          break;
        }
        case 30: {
          // vhcurveto dy1 dx2 dy2 dx3
          const [a, b, e, f] = st as [number, number, number, number];
          curveTo(x, y + a, x + b, y + a + e, x + b + f, y + a + e);
          st.length = 0;
          break;
        }
        case 31: {
          // hvcurveto dx1 dx2 dy2 dy3
          const [a, b, e, f] = st as [number, number, number, number];
          curveTo(x + a, y, x + a + b, y + e, x + a + b, y + e + f);
          st.length = 0;
          break;
        }
        case 9:
          if (open) d += 'Z';
          open = false;
          st.length = 0;
          break;
        case 10: {
          const s = subrs[st.pop()!];
          if (s && run(s)) return true;
          break;
        }
        case 11:
          depth--;
          return false;
        case 14:
          return true;
        case 1212: {
          const b2 = st.pop()!;
          const a = st.pop()!;
          st.push(a / b2);
          break;
        }
        case 1216: {
          // callothersubr: 0 ends flex, 1 starts it, 2 adds a flex point; others (hint replacement) hand their
          // arguments back through pop
          const other = st.pop()!;
          const n = st.pop()!;
          const args = st.splice(st.length - n, n);
          if (other === 1) {
            flex = [];
          } else if (other === 0 && flex) {
            const p = flex;
            flex = undefined;
            // p[0] is the reference point; p[1..6] the control and end points of two curves
            if (p.length >= 7) {
              curveTo(p[1]![0], p[1]![1], p[2]![0], p[2]![1], p[3]![0], p[3]![1]);
              curveTo(p[4]![0], p[4]![1], p[5]![0], p[5]![1], p[6]![0], p[6]![1]);
            }
            ps.push(y, x);
          } else ps.push(...args.reverse());
          break;
        }
        case 1217:
          st.push(ps.pop() ?? 0);
          break;
        case 1233:
          // setcurrentpoint
          x = st[0] ?? x;
          y = st[1] ?? y;
          st.length = 0;
          break;
        default:
          // stem hints, dotsection, seac (accented composites are not expected in subsets)
          st.length = 0;
      }
    }
    depth--;
    return false;
  };
  run(code);
  if (open) d += 'Z';
  return d;
}
