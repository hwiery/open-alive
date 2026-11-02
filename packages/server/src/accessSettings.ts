/**
 * Settings → Backend → "Require a token on this computer".
 *
 * A token is only ever asked for in remote mode (OPEN_ALIVE_REMOTE=1): then a
 * loopback address stops counting as proof of being local, because a tunnel or
 * reverse proxy makes every remote caller look like 127.0.0.1. This setting is
 * `OPEN_ALIVE_TRUST_LOOPBACK`, written to ~/.open-alive/.env and applied to the
 * running server at once. Outside remote mode it has no effect — this computer
 * never needs a token.
 */
import { readFileSync } from 'node:fs';
import { upsertEnvValue, writePrivateFile } from '@open-alive/core';

export interface AccessSettingsView {
  /** Remote access is on (only then can a token be required locally). */
  remoteEnabled: boolean;
  /** True = this computer must present a token too (loopback not trusted). */
  requireTokenLocally: boolean;
}

export interface AccessSettingsDeps {
  envFile: string;
  env: NodeJS.ProcessEnv;
  /** The live auth config; its `trustLoopback` is updated in place. */
  config: { enabled: boolean; trustLoopback: boolean };
}

export interface AccessSettings {
  get(): AccessSettingsView;
  setRequireTokenLocally(require: boolean): AccessSettingsView;
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

export function createAccessSettings(deps: AccessSettingsDeps): AccessSettings {
  const view = (): AccessSettingsView => ({
    remoteEnabled: deps.config.enabled,
    requireTokenLocally: deps.config.enabled && !deps.config.trustLoopback,
  });
  return {
    get: view,
    setRequireTokenLocally(require) {
      const trust = !require;
      writePrivateFile(deps.envFile, upsertEnvValue(readText(deps.envFile), 'OPEN_ALIVE_TRUST_LOOPBACK', trust ? '1' : '0'));
      deps.env.OPEN_ALIVE_TRUST_LOOPBACK = trust ? '1' : '0';
      deps.config.trustLoopback = trust;
      return view();
    },
  };
}
