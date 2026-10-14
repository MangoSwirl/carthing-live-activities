// bare cff (type 2 charstrings) outlines; archives embed custom otf subsets this way

type Index = Uint8Array[];

function readIndex(b: Uint8Array, at: number): [Index, number] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const count = dv.getUint16(at);
  if (!count) return [[], at + 2];
  const os = b[at + 2]!;
  const off = (i: number) => {
    let v = 0;
    for (let k = 0; k < os; k++) v = v * 256 + b[at + 3 + i * os + k]!;
    return v;
  };
  const base = at + 2 + (count + 1) * os;
  const items: Index = [];
  for (let i = 0; i < count; i++) items.push(b.subarray(base + off(i), base + off(i + 1)));
  return [items, base + off(count)];
}

function readDict(d: Uint8Array): Map<number, number[]> {
  const out = new Map<number, number[]>();
  let ops: number[] = [];
  for (let i = 0; i < d.length; ) {
    const v = d[i]!;
    if (v <= 21) {
      const key = v === 12 ? 1200 + d[i + 1]! : v;
      i += v === 12 ? 2 : 1;
      out.set(key, ops);
      ops = [];
    } else if (v === 28) {
      ops.push(((d[i + 1]! << 24) >> 16) | d[i + 2]!);
      i += 3;
    } else if (v === 29) {
      ops.push((d[i + 1]! << 24) | (d[i + 2]! << 16) | (d[i + 3]! << 8) | d[i + 4]!);
      i += 5;
    } else if (v === 30) {
      let s = '';
      i++;
      outer: for (;;) {
        const byte = d[i++]!;
        for (const nib of [byte >> 4, byte & 15]) {
          if (nib === 15) break outer;
          s += '0123456789.EE?-'[nib] + (nib === 12 ? '-' : '');
        }
      }
      ops.push(parseFloat(s));
    } else if (v >= 32 && v <= 246) ops.push(v - 139), i++;
    else if (v >= 247 && v <= 250) ops.push((v - 247) * 256 + d[i + 1]! + 108), (i += 2);
    else if (v >= 251 && v <= 254) ops.push(-(v - 251) * 256 - d[i + 1]! - 108), (i += 2);
    else i++;
  }
  return out;
}

const bias = (n: number) => (n < 1240 ? 107 : n < 33900 ? 1131 : 32768);

export function parseCFF(b: Uint8Array): { unitsPerEm: number; numGlyphs: number; glyphPath(gid: number): string } {
  const hdr = b[2]!;
  const [, a1] = readIndex(b, hdr); // names
  const [tops, a2] = readIndex(b, a1);
  const [, a3] = readIndex(b, a2); // strings
  const [gsubrs] = readIndex(b, a3);
  const top = readDict(tops[0] ?? new Uint8Array());
  const [charstrings] = readIndex(b, top.get(17)?.[0] ?? 0);
  const fm = top.get(1207);
  const unitsPerEm = fm?.[0] ? Math.round(1 / fm[0]) : 1000;

  const privSubrs = (p: number[] | undefined): Index => {
    if (!p || p.length < 2) return [];
    const pd = readDict(b.subarray(p[1]!, p[1]! + p[0]!));
    const so = pd.get(19)?.[0];
    return so ? readIndex(b, p[1]! + so)[0] : [];
  };
  // cid-keyed fonts pick private subrs per glyph through fdselect
  let subrsFor: (gid: number) => Index;
  const fdArrayOff = top.get(1236)?.[0];
  if (fdArrayOff !== undefined) {
    const [fds] = readIndex(b, fdArrayOff);
    const fdSubrs = fds.map((fd) => privSubrs(readDict(fd).get(18)));
    const sel = top.get(1237)?.[0] ?? 0;
    const fmt = b[sel];
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    subrsFor = (gid) => {
      if (fmt === 0) return fdSubrs[b[sel + 1 + gid]!] ?? [];
      const n = dv.getUint16(sel + 1);
      for (let i = 0; i < n; i++) {
        const first = dv.getUint16(sel + 3 + 3 * i);
        const next = dv.getUint16(sel + 3 + 3 * (i + 1));
        if (gid >= first && gid < next) return fdSubrs[b[sel + 5 + 3 * i]!] ?? [];
      }
      return [];
    };
  } else {
    const s = privSubrs(top.get(18));
    subrsFor = () => s;
  }

  const glyphPath = (gid: number): string => {
    const cs = charstrings[gid];
    if (!cs) return '';
    const subrs = subrsFor(gid);
    const r = (v: number) => +v.toFixed(1);
    let d = '';
    let x = 0;
    let y = 0;
    let open = false;
    let stems = 0;
    let widthDone = false;
    const st: number[] = [];
    const move = (dx: number, dy: number) => {
      if (open) d += 'Z';
      x += dx;
      y += dy;
      d += `M${r(x)} ${r(y)}`;
      open = true;
    };
    const line = (dx: number, dy: number) => {
      x += dx;
      y += dy;
      d += `L${r(x)} ${r(y)}`;
    };
    const curve = (a: number, b2: number, c: number, e: number, f: number, g: number) => {
      const x1 = x + a;
      const y1 = y + b2;
      const x2 = x1 + c;
      const y2 = y1 + e;
      x = x2 + f;
      y = y2 + g;
      d += `C${r(x1)} ${r(y1)} ${r(x2)} ${r(y2)} ${r(x)} ${r(y)}`;
    };
    // an odd leading operand on the first stack-clearing op is the advance width
    const width = (even: boolean) => {
      if (!widthDone && st.length % 2 === (even ? 1 : 0)) st.shift();
      widthDone = true;
    };
    let depth = 0;
    const run = (code: Uint8Array): boolean => {
      if (++depth > 10) return true;
      for (let i = 0; i < code.length; ) {
        const v = code[i]!;
        if (v >= 32 || v === 28) {
          if (v === 28) st.push(((code[i + 1]! << 24) >> 16) | code[i + 2]!), (i += 3);
          else if (v <= 246) st.push(v - 139), i++;
          else if (v <= 250) st.push((v - 247) * 256 + code[i + 1]! + 108), (i += 2);
          else if (v <= 254) st.push(-(v - 251) * 256 - code[i + 1]! - 108), (i += 2);
          else st.push(((code[i + 1]! << 24) | (code[i + 2]! << 16) | (code[i + 3]! << 8) | code[i + 4]!) / 65536), (i += 5);
          continue;
        }
        i++;
        switch (v) {
          case 1: case 3: case 18: case 23:
            width(true);
            stems += st.length >> 1;
            st.length = 0;
            break;
          case 19: case 20:
            width(true);
            stems += st.length >> 1;
            st.length = 0;
            i += (stems + 7) >> 3;
            break;
          case 21:
            width(true);
            move(st[0]!, st[1]!);
            st.length = 0;
            break;
          case 22:
            width(false);
            move(st[0]!, 0);
            st.length = 0;
            break;
          case 4:
            width(false);
            move(0, st[0]!);
            st.length = 0;
            break;
          case 5:
            for (let k = 0; k + 1 < st.length; k += 2) line(st[k]!, st[k + 1]!);
            st.length = 0;
            break;
          case 6: case 7: {
            let h = v === 6;
            for (const n of st) h ? line(n, 0) : line(0, n), (h = !h);
            st.length = 0;
            break;
          }
          case 8:
            for (let k = 0; k + 5 < st.length; k += 6) curve(st[k]!, st[k + 1]!, st[k + 2]!, st[k + 3]!, st[k + 4]!, st[k + 5]!);
            st.length = 0;
            break;
          case 24: {
            let k = 0;
            for (; k + 7 < st.length; k += 6) curve(st[k]!, st[k + 1]!, st[k + 2]!, st[k + 3]!, st[k + 4]!, st[k + 5]!);
            line(st[k]!, st[k + 1]!);
            st.length = 0;
            break;
          }
          case 25: {
            let k = 0;
            for (; k + 7 < st.length; k += 2) line(st[k]!, st[k + 1]!);
            curve(st[k]!, st[k + 1]!, st[k + 2]!, st[k + 3]!, st[k + 4]!, st[k + 5]!);
            st.length = 0;
            break;
          }
          case 26: case 27: {
            let k = 0;
            let e = st.length % 2 ? st[k++]! : 0;
            for (; k + 3 < st.length; k += 4) {
              if (v === 26) curve(e, st[k]!, st[k + 1]!, st[k + 2]!, 0, st[k + 3]!);
              else curve(st[k]!, e, st[k + 1]!, st[k + 2]!, st[k + 3]!, 0);
              e = 0;
            }
            st.length = 0;
            break;
          }
          case 30: case 31: {
            let h = v === 31;
            for (let k = 0; k + 3 < st.length; k += 4) {
              const last = k + 5 === st.length ? st[k + 4]! : 0;
              if (h) curve(st[k]!, 0, st[k + 1]!, st[k + 2]!, last, st[k + 3]!);
              else curve(0, st[k]!, st[k + 1]!, st[k + 2]!, st[k + 3]!, last);
              h = !h;
            }
            st.length = 0;
            break;
          }
          case 10: case 29: {
            const set = v === 10 ? subrs : gsubrs;
            const n = st.pop()! + bias(set.length);
            const sub = set[n];
            if (sub && run(sub)) return true;
            break;
          }
          case 11:
            depth--;
            return false;
          case 14:
            width(true);
            if (open) d += 'Z';
            open = false;
            return true;
          case 12: {
            const e = code[i++]!;
            const s = st.splice(0);
            if (e === 35) curve(s[0]!, s[1]!, s[2]!, s[3]!, s[4]!, s[5]!), curve(s[6]!, s[7]!, s[8]!, s[9]!, s[10]!, s[11]!);
            else if (e === 34) curve(s[0]!, 0, s[1]!, s[2]!, s[3]!, 0), curve(s[4]!, 0, s[5]!, -s[2]!, s[6]!, 0);
            else if (e === 36) curve(s[0]!, s[1]!, s[2]!, s[3]!, s[4]!, 0), curve(s[5]!, 0, s[6]!, s[7]!, s[8]!, -(s[1]! + s[3]! + s[7]!));
            else if (e === 37) {
              const [sx, sy] = [x, y];
              const dx = s[0]! + s[2]! + s[4]! + s[6]! + s[8]!;
              const dy = s[1]! + s[3]! + s[5]! + s[7]! + s[9]!;
              curve(s[0]!, s[1]!, s[2]!, s[3]!, s[4]!, s[5]!);
              const horiz = Math.abs(dx) > Math.abs(dy);
              curve(s[6]!, s[7]!, s[8]!, s[9]!, horiz ? s[10]! : sx - x - s[6]! - s[8]!, horiz ? sy - y - s[7]! - s[9]! : s[10]!);
            }
            break;
          }
          default:
            st.length = 0;
        }
      }
      depth--;
      return false;
    };
    try {
      run(cs);
    } catch {
      return '';
    }
    if (open) d += 'Z';
    return d;
  };
  return { unitsPerEm, numGlyphs: charstrings.length, glyphPath };
}
