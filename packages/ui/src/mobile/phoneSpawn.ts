import type { WSClientMessage } from '@open-alive/core';
import type { PhoneTerminalMode } from './MobileSpawnPicker.tsx';

export interface PhoneSpawnInput {
  tabId: string;
  cwd: string;
  mode: PhoneTerminalMode;
  skipPermissions: boolean;
  /** Fresh Claude session id; used only for Claude so the PC links the tab to its session. */
  sessionId: string;
  /** Claude only, with account rotation: run on this account (absent = the server's choice). */
  claudeAccount?: string;
}

/** The `terminal:spawn` the phone sends for a picker choice. */
export function phoneSpawnMessage({ tabId, cwd, mode, skipPermissions, sessionId, claudeAccount }: PhoneSpawnInput): WSClientMessage {
  const common = { type: 'terminal:spawn' as const, tabId, cwd, source: 'local' as const };
  switch (mode) {
    case 'claude':
      return { ...common, mode: 'claude', skipPermissions, claudeSessionId: sessionId, ...(claudeAccount ? { claudeAccount } : {}) };
    case 'codex':
      return { ...common, mode: 'codex', skipPermissions };
    case 'codex-local':
      return { ...common, mode: 'codex', skipPermissions, localModel: true };
    case 'shell':
      return { ...common, mode: 'shell' };
  }
}
