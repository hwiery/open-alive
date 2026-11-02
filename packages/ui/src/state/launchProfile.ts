/**
 * What a new local terminal tab starts: which agent CLI, whether Codex runs on
 * the server's local model (`OA_LOCAL_MODEL`, `codex --oss`), and whether it skips
 * permission prompts (`claude --dangerously-skip-permissions` /
 * `codex --dangerously-bypass-approvals-and-sandbox`).
 *
 * The folder picker offers these as one-click presets and remembers the last
 * one, so the usual combination is set once instead of on every launch.
 */

export type LaunchAgent = 'claude' | 'codex';

export interface LaunchProfile {
  id: LaunchProfileId;
  agent: LaunchAgent;
  skipPermissions: boolean;
  /** Codex on the server's local model instead of the account's cloud model. */
  local: boolean;
}

export type LaunchProfileId =
  | 'claude'
  | 'claude-skip'
  | 'codex'
  | 'codex-skip'
  | 'codex-local'
  | 'codex-local-skip';

export const LAUNCH_PROFILES: readonly LaunchProfile[] = [
  { id: 'claude', agent: 'claude', skipPermissions: false, local: false },
  { id: 'claude-skip', agent: 'claude', skipPermissions: true, local: false },
  { id: 'codex', agent: 'codex', skipPermissions: false, local: false },
  { id: 'codex-skip', agent: 'codex', skipPermissions: true, local: false },
  { id: 'codex-local', agent: 'codex', skipPermissions: false, local: true },
  { id: 'codex-local-skip', agent: 'codex', skipPermissions: true, local: true },
];

export const LAUNCH_PROFILE_KEY = 'open-alive:launch-profile';
/** Matches the earlier behaviour: Claude with skip-permissions checked. */
export const DEFAULT_LAUNCH_PROFILE: LaunchProfileId = 'claude-skip';

type PrefStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function launchProfile(id: LaunchProfileId): LaunchProfile {
  return LAUNCH_PROFILES.find((p) => p.id === id) ?? LAUNCH_PROFILES[1];
}

/** The presets to show: the local-model ones only when the server has a local model. */
export function availableLaunchProfiles(hasLocalModel: boolean): LaunchProfile[] {
  return LAUNCH_PROFILES.filter((p) => hasLocalModel || !p.local);
}

/** The saved preset if it is still available, else the default. */
export function resolveLaunchProfile(id: LaunchProfileId, hasLocalModel: boolean): LaunchProfile {
  const profile = launchProfile(id);
  return profile.local && !hasLocalModel ? launchProfile(DEFAULT_LAUNCH_PROFILE) : profile;
}

export function loadLaunchProfile(storage: PrefStorage | undefined): LaunchProfileId {
  try {
    const raw = storage?.getItem(LAUNCH_PROFILE_KEY);
    return LAUNCH_PROFILES.some((p) => p.id === raw) ? (raw as LaunchProfileId) : DEFAULT_LAUNCH_PROFILE;
  } catch {
    return DEFAULT_LAUNCH_PROFILE;
  }
}

export function saveLaunchProfile(storage: PrefStorage | undefined, id: LaunchProfileId): void {
  try {
    storage?.setItem(LAUNCH_PROFILE_KEY, id);
  } catch {
    // Storage disabled: the choice just isn't remembered.
  }
}
