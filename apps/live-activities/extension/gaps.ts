// remembers what the decoder could not recognise or draw, so gaps found in the field are logged once and the
// archive that showed them is kept for reproducing later (in the extension's data folder, a few per code)

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

type Report = { warnings?: string[]; unknowns?: { code: string; detail?: string }[] };
const KEEP_PER_CODE = 3;

// warnings carry ids and numbers; fold them into stable codes so a gap is reported once, not once per widget
const codeOf = (w: string) => w.replace(/\b\d{4,}\b/g, '#').replace(/0x[0-9a-f]+/gi, '0x…');
const slug = (s: string) => s.replace(/[^a-z0-9.:-]+/gi, '-').slice(0, 80);

export function makeGapLog(dataDir: string, log: (msg: string) => void) {
  const dir = join(dataDir, 'decoder-gaps');
  // the host may not grant this extension file access at all; then gaps are only logged, not kept
  let seen = new Set<string>();
  try {
    if (existsSync(dir)) seen = new Set(readdirSync(dir));
  } catch {}
  return (report: Report | null | undefined, archivePath: string, label: string) => {
    if (!report) return;
    const codes = [
      ...(report.unknowns ?? []).map(u => ({ code: `unknown ${u.code}`, detail: u.detail })),
      ...(report.warnings ?? []).map(w => ({ code: `warning ${codeOf(w)}`, detail: undefined })),
    ];
    for (const { code, detail } of codes) {
      const key = slug(code);
      const folder = join(dir, key);
      if (!seen.has(key)) {
        seen.add(key);
        let kept = false;
        try {
          mkdirSync(folder, { recursive: true });
          copyFileSync(archivePath, join(folder, `${Date.now()}-${archivePath.split('/').pop()!.slice(0, 60)}`));
          kept = true;
        } catch {}
        log(`decoder gap in ${label}: ${code}${detail ? ` (${detail})` : ''}${kept ? `; archive kept in ${folder}` : ''}`);
        continue;
      }
      try {
        if (readdirSync(folder).length < KEEP_PER_CODE) {
          copyFileSync(archivePath, join(folder, `${Date.now()}-${archivePath.split('/').pop()!.slice(0, 60)}`));
        }
      } catch {}
    }
  };
}
