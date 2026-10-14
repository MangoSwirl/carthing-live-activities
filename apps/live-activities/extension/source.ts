// reads the live activities macos mirrors from a paired iphone, straight from the stores the system daemons keep:
//
//   iphone liveactivitiesd -> ids/replicator -> mac liveactivitiesd -> liveactivitiesd.sql (descriptor + content state)
//                                            -> mac chronod          -> remoteArchives/**.activity-archive (swiftui
//                                               display lists the iphone rendered from the app's widget extension)
//
// both live in restricted app group containers, so the process needs full disk access. nothing here talks to the
// daemons; it only reads what they persist, and watches the files so updates arrive as fast as macos gets them.

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const GROUPS = join(homedir(), 'Library/Group Containers');
export const DB_PATH = join(GROUPS, 'group.com.apple.liveactivitiesd/liveactivitiesd.sql');
export const ARCHIVES = join(GROUPS, 'group.com.apple.chronod/chronod/remoteArchives');

// apple timestamps count from 2001-01-01
const utf8 = new TextDecoder();
const APPLE_EPOCH_MS = 978_307_200_000;
const appleDate = (s: number | null | undefined) => (s == null ? null : APPLE_EPOCH_MS + s * 1000);

export type MirroredActivity = {
  id: string;
  bundleId: string;
  appName: string;
  deviceId: string | null;
  attributesType: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  staleAt: number | null;
  relevance: number;
  attributes: unknown;
  content: unknown;
  archivePath: string | null;
  archiveMtime: number;
};

// activitykit hands the app's Codable ContentState over as base64 json; apps often nest json strings inside it
function decodeJsonish(value: unknown, depth = 0): unknown {
  if (depth > 4) return value;
  if (typeof value === 'string') {
    const t = value.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        return decodeJsonish(JSON.parse(t), depth + 1);
      } catch {}
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(v => decodeJsonish(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodeJsonish(v, depth + 1)]));
  }
  return value;
}

function decodeBase64Json(b64: unknown): unknown {
  if (typeof b64 !== 'string' || !b64) return null;
  try {
    return decodeJsonish(utf8.decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

function findArchive(deviceId: string | null, bundleId: string, activityId: string): { path: string; mtime: number } | null {
  if (!deviceId) return null;
  const dir = join(ARCHIVES, deviceId, bundleId, 'com.apple.chrono/activities');
  if (!existsSync(dir)) return null;
  let best: { path: string; mtime: number } | null = null;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(activityId) || !name.endsWith('.activity-archive')) continue;
    const path = join(dir, name);
    const mtime = statSync(path).mtimeMs;
    if (!best || mtime > best.mtime) best = { path, mtime };
  }
  return best;
}

type Row = {
  activityIdentifier: string;
  deviceIdentifier: string | null;
  requester: string;
  localizedAppName: string | null;
  startDate: number;
  request: Uint8Array;
  payload: Uint8Array;
};


export function readActivities(): MirroredActivity[] {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `select activityIdentifier, deviceIdentifier, requester, localizedAppName, startDate, request, payload
         from Activities where dismissalDate is null order by startDate`,
      )
      .all() as unknown as Row[];
    return rows.map(row => {
      const request = JSON.parse(utf8.decode(row.request));
      const payload = JSON.parse(utf8.decode(row.payload));
      const content = payload.content ?? payload;
      const archive = findArchive(row.deviceIdentifier, row.requester, row.activityIdentifier);
      return {
        id: row.activityIdentifier,
        bundleId: row.requester,
        appName: row.localizedAppName ?? row.requester,
        deviceId: row.deviceIdentifier,
        attributesType: request.attributesType?.attributesType ?? null,
        startedAt: appleDate(row.startDate),
        updatedAt: appleDate(payload.timestamp),
        staleAt: appleDate(content.staleDate),
        relevance: content.relevanceScore ?? 0,
        attributes: decodeBase64Json(request.attributesData),
        content: decodeBase64Json(content.contentState),
        archivePath: archive?.path ?? null,
        archiveMtime: archive?.mtime ?? 0,
      };
    });
  } finally {
    db.close();
  }
}

// fsevents on the db's wal and the archive tree, debounced, with a slow poll in case an event is missed
export function watchActivities(onChange: () => void, { debounceMs = 120, pollMs = 10_000 } = {}): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const kick = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  };
  const watchers: FSWatcher[] = [];
  const dbDir = join(DB_PATH, '..');
  watchers.push(watch(dbDir, (_e, name) => name?.startsWith('liveactivitiesd.sql') && kick()));
  if (existsSync(ARCHIVES)) {
    watchers.push(watch(ARCHIVES, { recursive: true }, (_e, name) => name?.endsWith('.activity-archive') && kick()));
  }
  const poll = setInterval(onChange, pollMs);
  return () => {
    watchers.forEach(w => w.close());
    clearInterval(poll);
    if (timer) clearTimeout(timer);
  };
}
