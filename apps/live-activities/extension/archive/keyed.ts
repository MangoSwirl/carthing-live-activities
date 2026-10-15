// NSKeyedArchiver graphs (bplist with $objects/$top) as plain json, and a summary of archived App Intent actions

import { isBplist, parseBplist, type Plist } from './bplist';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

// resolves uids into nested json; objects keep their class as $class, collections become arrays/maps
export function unarchive(b: Uint8Array): Json | undefined {
  if (!isBplist(b)) return undefined;
  let root: any;
  try {
    root = parseBplist(b, { uids: true });
  } catch {
    return undefined;
  }
  const objs: Plist[] = root?.$objects;
  if (!Array.isArray(objs)) return undefined;
  const isUid = (v: any): v is { uid: number } => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.uid === 'number';
  const memo = new Map<number, Json>();
  const resolve = (v: any, depth: number): Json => {
    if (depth > 64) return null;
    if (isUid(v)) return obj(v.uid, depth + 1);
    if (v instanceof Uint8Array) return isBplist(v) ? (unarchive(v) ?? `base64:${Buffer.from(v).toString('base64')}`) : `base64:${Buffer.from(v).toString('base64')}`;
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map((x) => resolve(x, depth + 1));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, depth + 1)]));
    return v as Json;
  };
  const obj = (i: number, depth: number): Json => {
    if (memo.has(i)) return memo.get(i)!;
    const o: any = objs[i];
    if (o === '$null' || o === undefined) return null;
    if (!o || typeof o !== 'object' || Array.isArray(o) || o instanceof Uint8Array) return resolve(o, depth);
    memo.set(i, null); // cycle guard
    const cls: string | undefined = isUid(o.$class) ? (objs[o.$class.uid] as any)?.$classname : undefined;
    let out: Json;
    if ('NS.keys' in o && 'NS.objects' in o) {
      const ks = (o['NS.keys'] as any[]).map((k) => String(resolve(k, depth)));
      const vs = (o['NS.objects'] as any[]).map((x) => resolve(x, depth));
      out = Object.fromEntries(ks.map((k, j) => [k, vs[j] ?? null]));
    } else if ('NS.objects' in o) out = (o['NS.objects'] as any[]).map((x) => resolve(x, depth));
    else if (Object.keys(o).some((k) => k.startsWith('NS.object.'))) {
      out = Object.keys(o)
        .filter((k) => k.startsWith('NS.object.'))
        .sort((a, b) => Number(a.slice(10)) - Number(b.slice(10)))
        .map((k) => resolve(o[k], depth));
    } else if ('NS.relative' in o) out = resolve(o['NS.relative'], depth);
    else if ('NS.string' in o) out = resolve(o['NS.string'], depth);
    else {
      const fields: { [k: string]: Json } = cls ? { $class: cls } : {};
      for (const [k, x] of Object.entries(o)) if (k !== '$class') fields[k] = resolve(x, depth);
      out = fields;
    }
    memo.set(i, out);
    return out;
  };
  return obj((root.$top as any)?.root?.uid ?? 1, 0);
}

export type IntentSummary = {
  identifier?: string; // intent type, e.g. TTRReminderSetCompletedIntent
  mangledTypeName?: string;
  bundleIdentifier?: string;
  openAppWhenRun?: boolean;
  parameters: { identifier: string; value: unknown }[];
};

// LNAction: { identifier, mangledTypeName, openAppWhenRun, parameters: [LNProperty { identifier, value: LNValue }],
// metadata { effectiveBundleIdentifiers: [LNEffectiveBundleIdentifier { bundleIdentifier }] } }
export function summarizeAction(action: Json | undefined): IntentSummary | undefined {
  const a = action as any;
  if (!a || typeof a !== 'object') return undefined;
  const value = (v: any): unknown => {
    const inner = v?.value;
    if (inner?.$class === 'LNEntity') {
      return {
        entity: inner.identifier?.typeIdentifier ?? v?.valueType?.identifier,
        id: inner.identifier?.instanceIdentifier,
        title: v?.displayRepresentation?.title?.defaultValue ?? v?.displayRepresentation?.title?.key,
      };
    }
    if (inner && typeof inner === 'object' && '$class' in inner) return inner;
    return inner;
  };
  const bundles: string[] = [];
  const findBundle = (o: any, d: number) => {
    if (!o || typeof o !== 'object' || d > 8) return;
    if (o.$class === 'LNEffectiveBundleIdentifier' && typeof o.bundleIdentifier === 'string') bundles.push(o.bundleIdentifier);
    for (const v of Object.values(o)) findBundle(v, d + 1);
  };
  findBundle(a.metadata, 0);
  return {
    identifier: typeof a.identifier === 'string' ? a.identifier : undefined,
    mangledTypeName: typeof a.mangledTypeName === 'string' ? a.mangledTypeName : undefined,
    bundleIdentifier: bundles[0],
    openAppWhenRun: typeof a.openAppWhenRun === 'boolean' ? a.openAppWhenRun : undefined,
    parameters: (Array.isArray(a.parameters) ? a.parameters : [])
      .filter((p: any) => p && typeof p.identifier === 'string')
      .map((p: any) => ({ identifier: p.identifier, value: value(p.value) })),
  };
}
