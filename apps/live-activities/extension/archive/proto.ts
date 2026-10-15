// minimal protobuf wire reader; the archive has no schema so fields stay lazy

export type Field = {
  no: number;
  wt: number; // 0 varint, 1 fixed64, 2 bytes, 5 fixed32
  v: number; // varint value (lossy above 2^53) or 0
  raw: Uint8Array; // payload for wt 1/2/5
};

export class Msg {
  readonly fields: Field[];
  // field numbers some accessor touched; checkUnread reports the rest
  private readonly touched = new Set<number>();
  constructor(readonly bytes: Uint8Array) {
    this.fields = parseFields(bytes);
  }
  // the first field (oneof-style messages carry their case as the only field)
  first(): Field | undefined {
    const f = this.fields[0];
    if (f) this.touched.add(f.no);
    return f;
  }
  // fields we know about and deliberately do not use
  ignore(...nos: number[]): this {
    for (const n of nos) this.touched.add(n);
    return this;
  }
  unread(): Field[] {
    return this.fields.filter((f) => !this.touched.has(f.no));
  }
  // lenient sub-message: wrong wire type or garbage yields an empty message
  static from(f: Field | undefined): Msg {
    if (!f || f.wt !== 2) return EMPTY_MSG;
    try {
      return new Msg(f.raw);
    } catch {
      return EMPTY_MSG;
    }
  }
  all(no: number): Field[] {
    this.touched.add(no);
    return this.fields.filter((f) => f.no === no);
  }
  get(no: number): Field | undefined {
    this.touched.add(no);
    for (let i = this.fields.length - 1; i >= 0; i--) if (this.fields[i]!.no === no) return this.fields[i];
    return undefined;
  }
  has(no: number): boolean {
    return this.get(no) !== undefined;
  }
  msg(no: number): Msg | undefined {
    const f = this.get(no);
    return f && f.wt === 2 ? Msg.from(f) : undefined;
  }
  msgs(no: number): Msg[] {
    return this.all(no)
      .filter((f) => f.wt === 2)
      .map((f) => Msg.from(f));
  }
  int(no: number, def = 0): number {
    const f = this.get(no);
    return f && f.wt === 0 ? f.v : def;
  }
  // signed varint stored as two's complement 64-bit
  sint(no: number, def = 0): number {
    const v = this.int(no, def);
    return v >= 2 ** 63 ? v - 2 ** 64 : v;
  }
  float(no: number, def = 0): number {
    const f = this.get(no);
    if (!f) return def;
    const dv = new DataView(f.raw.buffer, f.raw.byteOffset, f.raw.byteLength);
    if (f.wt === 5) return dv.getFloat32(0, true);
    if (f.wt === 1) return dv.getFloat64(0, true);
    if (f.wt === 0) return f.v;
    return def;
  }
  bool(no: number, def = false): boolean {
    const f = this.get(no);
    return f ? f.v !== 0 : def;
  }
  bytesOf(no: number): Uint8Array | undefined {
    const f = this.get(no);
    return f && f.wt === 2 ? f.raw : undefined;
  }
  str(no: number): string | undefined {
    const b = this.bytesOf(no);
    return b ? new TextDecoder().decode(b) : undefined;
  }
}

export function parseFields(b: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  const varint = (): number => {
    let r = 0;
    let s = 1;
    for (;;) {
      if (i >= b.length) throw new Error('truncated varint');
      const c = b[i++]!;
      r += (c & 0x7f) * s;
      s *= 128;
      if (c < 0x80) return r;
    }
  };
  while (i < b.length) {
    const key = varint();
    const wt = key % 8;
    const no = Math.floor(key / 8);
    if (no === 0) throw new Error('field 0');
    if (wt === 0) out.push({ no, wt, v: varint(), raw: EMPTY });
    else if (wt === 1 || wt === 5) {
      const n = wt === 1 ? 8 : 4;
      if (i + n > b.length) throw new Error('truncated fixed');
      out.push({ no, wt, v: 0, raw: b.subarray(i, i + n) });
      i += n;
    } else if (wt === 2) {
      const n = varint();
      if (i + n > b.length) throw new Error('truncated bytes');
      out.push({ no, wt, v: 0, raw: b.subarray(i, i + n) });
      i += n;
    } else throw new Error(`wire type ${wt}`);
  }
  return out;
}

const EMPTY = new Uint8Array(0);

// ---------------------------------------------------------------- unknown data, collected per decode

export type Unknown = { code: string; detail?: string; count: number };

export class Unknowns {
  private map = new Map<string, Unknown>();
  add(code: string, detail?: string, count = 1) {
    const u = this.map.get(code);
    if (u) u.count += count;
    else this.map.set(code, { code, detail, count });
  }
  merge(list: Unknown[]) {
    for (const u of list) this.add(u.code, u.detail, u.count);
  }
  list(): Unknown[] {
    return [...this.map.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  }
}

let sink: Unknowns | undefined;

// runs fn with every unknown reported into u
export function collecting<T>(u: Unknowns, fn: () => T): T {
  const prev = sink;
  sink = u;
  try {
    return fn();
  } finally {
    sink = prev;
  }
}

export function unknown(code: string, detail?: string) {
  sink?.add(code, detail);
}

// replays unknowns collected earlier (e.g. while decoding a cached chunk) into the current collector
export function reportAll(list: Unknown[]) {
  sink?.merge(list);
}

// reports fields present in m that no accessor read, as unread:<role>.<field>
export function checkUnread(m: Msg | undefined, role: string) {
  if (!m || !sink) return;
  for (const f of m.unread()) sink.add(`unread:${role}.${f.no}`, preview(f));
}

export function preview(f: Field): string {
  if (f.wt === 0) return `varint ${f.v}`;
  if (f.wt === 5) return `f32 ${+new DataView(f.raw.buffer, f.raw.byteOffset, 4).getFloat32(0, true).toFixed(4)}`;
  if (f.wt === 1) return `f64/fixed64 ${hex(f.raw)}`;
  const text = f.raw.length && f.raw.every((c) => c >= 32 && c < 127);
  return text ? `"${new TextDecoder().decode(f.raw.subarray(0, 32))}"` : `bytes[${f.raw.length}] ${hex(f.raw.subarray(0, 12))}`;
}
const EMPTY_MSG = new Msg(EMPTY);

function looksLikeMsg(b: Uint8Array): boolean {
  if (!b.length) return false;
  try {
    parseFields(b);
    return true;
  } catch {
    return false;
  }
}

// schema-less dump for debugging (--json raw)
export function dumpMsg(b: Uint8Array, depth = 0): unknown {
  const out: [string, unknown][] = [];
  for (const f of parseFields(b)) {
    let v: unknown;
    if (f.wt === 0) v = f.v;
    else if (f.wt === 5) v = new DataView(f.raw.buffer, f.raw.byteOffset).getFloat32(0, true);
    else if (f.wt === 1) v = `fixed64:${hex(f.raw)}`;
    else {
      const printable = f.raw.length > 0 && f.raw.every((c) => c >= 32 && c < 127);
      if (printable && f.raw.length < 200) v = new TextDecoder().decode(f.raw);
      else if (depth < 64 && looksLikeMsg(f.raw)) v = dumpMsg(f.raw, depth + 1);
      else v = `bytes[${f.raw.length}]:${hex(f.raw.subarray(0, 24))}`;
    }
    out.push([String(f.no), v]);
  }
  return out.map(([k, v]) => ({ [k]: v }));
}

// plain implementations so the decoder runs unchanged under bun and deno
export const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

export function base64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function f16(bits: number): number {
  const s = bits & 0x8000 ? -1 : 1;
  const e = (bits >> 10) & 0x1f;
  const m = bits & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}
