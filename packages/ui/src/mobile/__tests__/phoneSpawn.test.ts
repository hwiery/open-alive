import { describe, it, expect } from 'vitest';
import { phoneSpawnMessage } from '../phoneSpawn.ts';

const base = { tabId: 'phone-1', cwd: '/w/app', sessionId: '11111111-1111-4111-8111-111111111111' };

describe('phoneSpawnMessage', () => {
  it('starts Claude with a fresh session id', () => {
    expect(phoneSpawnMessage({ ...base, mode: 'claude', skipPermissions: true })).toEqual({
      type: 'terminal:spawn', tabId: 'phone-1', cwd: '/w/app', mode: 'claude', source: 'local',
      skipPermissions: true, claudeSessionId: base.sessionId,
    });
  });

  it('starts Codex without a Claude session id', () => {
    expect(phoneSpawnMessage({ ...base, mode: 'codex', skipPermissions: false })).toEqual({
      type: 'terminal:spawn', tabId: 'phone-1', cwd: '/w/app', mode: 'codex', source: 'local', skipPermissions: false,
    });
  });

  it('asks for the local model for codex-local', () => {
    expect(phoneSpawnMessage({ ...base, mode: 'codex-local', skipPermissions: true })).toEqual({
      type: 'terminal:spawn', tabId: 'phone-1', cwd: '/w/app', mode: 'codex', source: 'local',
      skipPermissions: true, localModel: true,
    });
  });

  it('starts a plain shell', () => {
    expect(phoneSpawnMessage({ ...base, mode: 'shell', skipPermissions: true })).toEqual({
      type: 'terminal:spawn', tabId: 'phone-1', cwd: '/w/app', mode: 'shell', source: 'local',
    });
  });

  it('passes a chosen Claude account, and never for other modes', () => {
    expect(phoneSpawnMessage({ ...base, mode: 'claude', skipPermissions: false, claudeAccount: 'alt1' })).toMatchObject({
      mode: 'claude', claudeAccount: 'alt1',
    });
    expect(phoneSpawnMessage({ ...base, mode: 'shell', skipPermissions: false, claudeAccount: 'alt1' })).not.toHaveProperty('claudeAccount');
  });
});
