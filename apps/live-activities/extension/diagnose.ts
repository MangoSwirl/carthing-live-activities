// turns setup mistakes into something a user can act on. the car thing shows these when it has nothing else to show,
// and the desktop app's log gets the same text.

import { readdirSync, readFileSync } from 'node:fs';
import { homedir, release } from 'node:os';
import { join } from 'node:path';

import { parseBplist } from './archive/bplist';

export type Problem = {
  code: 'not-macos' | 'old-macos' | 'no-full-disk-access' | 'permission' | 'live-activities-off' | 'no-iphone' | 'never-synced';
  title: string;
  detail: string;
  steps: string[];
};

// darwin 25 is macOS 26, the first release that mirrors iPhone Live Activities
const MIN_DARWIN = 25;

const GROUPS = () => join(homedir(), 'Library/Group Containers');

const problems = {
  notMacos: (platform: string): Problem => ({
    code: 'not-macos',
    title: 'Live Activities needs a Mac',
    detail: `This computer runs ${platform}. Only macOS receives your iPhone's Live Activities.`,
    steps: ['Install the bridgething desktop app on a Mac with macOS 26 or later', 'Install Live Activities there'],
  }),
  oldMacos: (darwin: number): Problem => ({
    code: 'old-macos',
    title: 'This Mac needs macOS 26',
    detail: `iPhone Live Activities on the Mac arrived in macOS 26 Tahoe; this Mac runs macOS ${darwin + 1}.`,
    steps: ['Update the Mac in System Settings > General > Software Update'],
  }),
  noFullDiskAccess: (): Problem => ({
    code: 'no-full-disk-access',
    title: 'Give bridgething Full Disk Access',
    detail: 'macOS keeps Live Activities in protected folders that only apps with Full Disk Access can read.',
    steps: [
      'On the Mac, open System Settings > Privacy & Security > Full Disk Access',
      'Turn on bridgething (use + to add it from Applications if it is missing)',
      'Quit and reopen the bridgething desktop app',
    ],
  }),
  permission: (what: string): Problem => ({
    code: 'permission',
    title: 'Live Activities is missing a permission',
    detail: `The extension was not allowed to ${what}.`,
    steps: ['In the bridgething desktop app, reinstall Live Activities and approve its permissions'],
  }),
  off: (): Problem => ({
    code: 'live-activities-off',
    title: 'iPhone Live Activities are off on this Mac',
    detail: 'The Mac is not receiving Live Activities from your iPhone.',
    steps: ['On the Mac, open System Settings and search for "Live Activities"', 'Turn on Live Activities from iPhone'],
  }),
  noIphone: (): Problem => ({
    code: 'no-iphone',
    title: 'No iPhone is connected to this Mac',
    detail: 'The Mac shows Live Activities from an iPhone signed in to the same Apple Account.',
    steps: [
      'Sign in to the same Apple Account on the iPhone (iOS 26 or later) and the Mac',
      'Keep Bluetooth and Wi-Fi on for both, then search System Settings for "Live Activities"',
    ],
  }),
  neverSynced: (): Problem => ({
    code: 'never-synced',
    title: 'Waiting for a first Live Activity',
    detail: 'This Mac has not received any Live Activity from your iPhone yet.',
    steps: ['Start one on the iPhone, for example a timer in an app that shows Live Activities', 'It should appear in the Mac menu bar, then here'],
  }),
};

const notCapable = (err: unknown) => (err as Error)?.name === 'NotCapable';

/** the first thing standing between this mac and working live activities, or null when everything checks out */
export function diagnose(): Problem | null {
  if (process.platform !== 'darwin') return problems.notMacos(process.platform === 'win32' ? 'Windows' : process.platform);
  try {
    const darwin = parseInt(release(), 10);
    if (darwin && darwin < MIN_DARWIN) return problems.oldMacos(darwin);
  } catch (err) {
    if (notCapable(err)) return problems.permission('read the macOS version');
  }

  // listing the container tells the cases apart; sqlite only ever says "unable to open database file"
  try {
    readdirSync(join(GROUPS(), 'group.com.apple.liveactivitiesd'));
  } catch (err) {
    if (notCapable(err)) return problems.permission('read the Live Activities store');
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') return problems.noFullDiskAccess();
    if (code !== 'ENOENT') throw err;
    return settingsProblem() ?? problems.neverSynced();
  }
  return settingsProblem();
}

// control center records whether iphone live activities are on and whether an iphone is paired
function settingsProblem(): Problem | null {
  try {
    const prefs = parseBplist(new Uint8Array(readFileSync(join(homedir(), 'Library/Preferences/com.apple.controlcenter.plist'))));
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs) || prefs instanceof Uint8Array || prefs instanceof Date) return null;
    if (prefs.RemoteLiveActivitiesEnabled === false) return problems.off();
    const state = prefs.LiveActivityState;
    if (state instanceof Uint8Array) {
      const s = JSON.parse(new TextDecoder().decode(state));
      if (s.Enabled === false || s.SettingEnabled === false) return problems.off();
      if (s.CompanionPaired === false) return problems.noIphone();
    }
  } catch {}
  return null;
}

/** classifies an error from reading the stores after setup looked fine */
export function problemFromError(err: unknown): Problem {
  if (notCapable(err)) return problems.permission('read the Live Activities store');
  return diagnose() ?? problems.noFullDiskAccess();
}
