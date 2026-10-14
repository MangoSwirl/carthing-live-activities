// brings this webapp to the front when a new activity starts. the extension api only forwards to the active webapp,
// so switching takes a one-off request on the daemon's network gateway (ws :8892, 16-byte frame header + msgpack).

import { decode, encode } from '@msgpack/msgpack';
import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';

const PORT = 8892;
const TIMEOUT_MS = 3000;

const uuidBytes = (s: string) => Uint8Array.from(s.replace(/-/g, '').match(/../g)!, h => parseInt(h, 16));
const hexOf = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

function frame(message: unknown): Uint8Array<ArrayBuffer> {
  const body = encode(message);
  const out = new Uint8Array(new ArrayBuffer(16 + body.length));
  const view = new DataView(out.buffer);
  view.setUint16(0, 0xdead);
  view.setUint8(2, 2);
  view.setBigUint64(8, BigInt(body.length));
  out.set(body, 16);
  return out;
}

function request(host: string, data: unknown): Promise<any> {
  return new Promise(resolve => {
    const id = crypto.getRandomValues(new Uint8Array(16));
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://${host}:${PORT}/`);
    } catch {
      return resolve(null);
    }
    ws.binaryType = 'arraybuffer';
    const done = (v: unknown) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => done(null), TIMEOUT_MS);
    ws.onerror = () => done(null);
    ws.onopen = () => ws.send(frame({ id, meta: { kind: 'request' }, data }));
    ws.onmessage = ev => {
      const buf = new Uint8Array(ev.data as ArrayBuffer);
      if (buf.length < 16 || new DataView(buf.buffer).getUint16(0) !== 0xdead) return;
      try {
        const msg: any = decode(buf.subarray(16));
        if (msg?.meta?.kind === 'response' && hexOf(msg.meta.data.requestId) === hexOf(id)) done(msg.data);
      } catch {}
    };
  });
}

// the usb link is a dhcp /29, so its peers are the few other addresses in each 10.42.x.x/29 the mac sits on
async function candidates(): Promise<string[]> {
  const hosts = new Set<string>();
  const mdns = await lookup('bridgething.local', { family: 4 }).catch(() => null);
  if (mdns) hosts.add(mdns.address);
  let ifaces: ReturnType<typeof networkInterfaces> = {};
  try {
    ifaces = networkInterfaces();
  } catch {}
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || !a.address.startsWith('10.42.')) continue;
      const parts = a.address.split('.').map(Number);
      const base = parts[3]! & ~7;
      for (let i = 1; i < 7; i++) if (base + i !== parts[3]) hosts.add(`${parts[0]}.${parts[1]}.${parts[2]}.${base + i}`);
    }
  }
  return [...hosts];
}

async function activeOn(host: string): Promise<Uint8Array | null | undefined> {
  const r = await request(host, { type: 'webapp', data: { event: 'getActive' } });
  if (r?.type !== 'webapp' || r.data?.event !== 'active') return undefined;
  return r.data.data?.id ?? null;
}

const switchTo = async (host: string, id: Uint8Array) =>
  (await request(host, { type: 'webapp', data: { event: 'switchTo', data: { id } } }))?.data?.event === 'switched';

// what each device showed before we took over, so it can go back when the last activity ends
const previous = new Map<string, Uint8Array>();

/** switches every reachable car thing to this webapp; returns how many switched */
export async function bringForward(webappId: string): Promise<number> {
  const id = uuidBytes(webappId);
  let switched = 0;
  await Promise.all(
    (await candidates()).map(async host => {
      const current = await activeOn(host);
      if (current === undefined || (current && hexOf(current) === hexOf(id))) return;
      if (await switchTo(host, id)) {
        if (current) previous.set(host, current);
        switched++;
      }
    }),
  );
  return switched;
}

/** hands each device back to the app it showed before, if this webapp is still the one in front */
export async function restore(webappId: string): Promise<void> {
  const want = hexOf(uuidBytes(webappId));
  await Promise.all(
    [...previous].map(async ([host, prev]) => {
      const current = await activeOn(host);
      if (current && hexOf(current) === want) await switchTo(host, prev);
    }),
  );
  previous.clear();
}
