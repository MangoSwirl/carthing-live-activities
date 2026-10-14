// minimal bplist00 reader; widget archives store their data attachment this way

export type Plist = null | boolean | number | string | Uint8Array | Date | Plist[] | { [k: string]: Plist };

export function isBplist(b: Uint8Array): boolean {
  return b.length > 40 && new TextDecoder().decode(b.subarray(0, 8)) === 'bplist00';
}

export function parseBplist(b: Uint8Array): Plist {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const t = b.length - 32;
  const offSize = b[t + 6]!;
  const refSize = b[t + 7]!;
  const numObjects = Number(dv.getBigUint64(t + 8));
  const top = Number(dv.getBigUint64(t + 16));
  const tableOff = Number(dv.getBigUint64(t + 24));
  const uint = (at: number, n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + b[at + i]!;
    return v;
  };
  const offsets = Array.from({ length: numObjects }, (_, i) => uint(tableOff + i * offSize, offSize));
  const seen = new Set<number>();

  const read = (ref: number): Plist => {
    if (seen.has(ref)) throw new Error('bplist cycle');
    seen.add(ref);
    try {
      return readAt(offsets[ref]!);
    } finally {
      seen.delete(ref);
    }
  };
  // length nibble 0xf means an int object follows with the real length
  const len = (at: number): [number, number] => {
    const lo = b[at]! & 0xf;
    if (lo !== 0xf) return [lo, at + 1];
    const n = 1 << (b[at + 1]! & 0xf);
    return [uint(at + 2, n), at + 2 + n];
  };
  const readAt = (at: number): Plist => {
    const m = b[at]!;
    const hi = m >> 4;
    switch (hi) {
      case 0x0:
        return m === 0x09 ? true : m === 0x08 ? false : null;
      case 0x1: {
        const n = 1 << (m & 0xf);
        if (n === 8) return Number(dv.getBigInt64(at + 1));
        return uint(at + 1, n);
      }
      case 0x2:
        return (m & 0xf) === 2 ? dv.getFloat32(at + 1) : dv.getFloat64(at + 1);
      case 0x3: {
        // apple epoch 2001-01-01; distantFuture overflows nothing in js
        return new Date((dv.getFloat64(at + 1) + 978307200) * 1000);
      }
      case 0x4: {
        const [n, s] = len(at);
        return b.subarray(s, s + n);
      }
      case 0x5: {
        const [n, s] = len(at);
        return String.fromCharCode(...b.subarray(s, s + n));
      }
      case 0x6: {
        const [n, s] = len(at);
        let out = '';
        for (let i = 0; i < n; i++) out += String.fromCharCode(dv.getUint16(s + 2 * i));
        return out;
      }
      case 0x8:
        return uint(at + 1, (m & 0xf) + 1);
      case 0xa: {
        const [n, s] = len(at);
        return Array.from({ length: n }, (_, i) => read(uint(s + i * refSize, refSize)));
      }
      case 0xd: {
        const [n, s] = len(at);
        const o: { [k: string]: Plist } = {};
        for (let i = 0; i < n; i++) {
          const k = read(uint(s + i * refSize, refSize));
          o[String(k)] = read(uint(s + (n + i) * refSize, refSize));
        }
        return o;
      }
      default:
        throw new Error(`bplist marker ${m.toString(16)}`);
    }
  };
  return read(top);
}
