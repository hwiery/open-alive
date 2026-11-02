import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MobileProject } from './types.ts';
import { COLORS, screen, topBar, body, secondaryButton, primaryButton, input, label, TYPE, clamp1 } from './styles.ts';
import { browserStorage, readTerminalPref, saveTerminalPref } from '../state/terminalDock.ts';
import { pathTail } from './MobileSessionList.tsx';

/** `codex-local` runs Codex on the server's local model (`OA_LOCAL_MODEL`). */
export type PhoneTerminalMode = 'claude' | 'codex' | 'codex-local' | 'shell';

const MODES: readonly PhoneTerminalMode[] = ['claude', 'codex', 'codex-local', 'shell'];
const MODE_LABEL: Record<PhoneTerminalMode, string> = {
  claude: 'mobile.spawnClaude',
  codex: 'mobile.spawnCodex',
  'codex-local': 'mobile.spawnCodexLocal',
  shell: 'mobile.spawnShell',
};

export interface MobileSpawnRequest {
  cwd: string;
  mode: PhoneTerminalMode;
  /** Claude/Codex: skip permission prompts, as the PC dialog's presets. Always false for a shell. */
  skipPermissions: boolean;
}

export interface MobileSpawnPickerProps {
  /** Folders the PC is running sessions in right now (the PC dialog's quick select). */
  running?: MobileProject[];
  /** Folders used before, most recent first: this device's launches, then the session history. */
  recent?: MobileProject[];
  /** The server's allowlist (OPEN_ALIVE_TICKET_ROOTS). */
  projects: MobileProject[];
  /** The server's local model name, if it has one; enables the local Codex choice. */
  localModel?: string | null;
  onCancel: () => void;
  onSpawn: (request: MobileSpawnRequest) => void;
}

const MODE_KEY = 'open-alive:mobile-spawn-mode';
const SKIP_KEY = 'open-alive:mobile-skip-permissions';

/**
 * The phone's version of the PC "new terminal" dialog: what to run (Claude,
 * as the PC launches by default, Codex, Codex on the server's local model, or
 * a plain shell), with the PC's
 * skip-permissions switch (off by default here), then where — folders running now, folders used
 * before, the allowlist, or a typed path. Tapping a folder starts it, as on
 * the PC. Mode and the switch are remembered on this device.
 */
export function MobileSpawnPicker({ running = [], recent = [], projects, localModel, onCancel, onSpawn }: MobileSpawnPickerProps) {
  const { t } = useTranslation();
  const storage = browserStorage();
  const modes = MODES.filter((m) => m !== 'codex-local' || !!localModel);
  const [chosen, setMode] = useState<PhoneTerminalMode>(() => {
    const saved = readTerminalPref(storage, MODE_KEY);
    return MODES.find((m) => m === saved) ?? 'claude';
  });
  // A remembered local choice falls back to Claude while the server offers none.
  const mode: PhoneTerminalMode = modes.includes(chosen) ? chosen : 'claude';
  const agent = mode !== 'shell';
  // Off until this device opts in, unlike the PC dialog: a remote device's
  // token is easier to lose than a seat at the PC. The opt-in is remembered.
  const [skip, setSkip] = useState(() => readTerminalPref(storage, SKIP_KEY) === '1');
  const [manual, setManual] = useState('');

  const chooseMode = (next: PhoneTerminalMode) => {
    setMode(next);
    saveTerminalPref(storage, MODE_KEY, next);
  };
  const toggleSkip = () => {
    setSkip(!skip);
    saveTerminalPref(storage, SKIP_KEY, skip ? '0' : '1');
  };
  const start = (cwd: string) => onSpawn({ cwd, mode, skipPermissions: agent && skip });

  // Each folder once, in the first section that lists it.
  const seen = new Set<string>();
  const unique = (list: MobileProject[]) => list.filter((p) => p.path && !seen.has(p.path) && seen.add(p.path));
  const sections = [
    { key: 'running', title: t('mobile.spawnRunning'), items: unique(running) },
    { key: 'recent', title: t('mobile.spawnRecent'), items: unique(recent) },
    { key: 'allowed', title: t('mobile.spawnAllowed'), items: unique(projects) },
  ].filter((section) => section.items.length > 0);

  return (
    <div style={screen}>
      <div style={topBar}>
        <button style={{ ...secondaryButton, padding: '0 12px' }} onClick={onCancel}>{t('mobile.back')}</button>
        <span style={{ fontSize: 17, fontWeight: 600 }}>{t('mobile.terminalNew')}</span>
      </div>
      <div style={body}>
        <span style={label}>{t('mobile.spawnModeLabel')}</span>
        <div role="radiogroup" aria-label={t('mobile.spawnModeLabel')} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 10 }}>
          {modes.map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={mode === m}
              onClick={() => chooseMode(m)}
              style={{
                minHeight: 44, borderRadius: 10, cursor: 'pointer', fontSize: 15, fontWeight: 600,
                border: `1px solid ${mode === m ? COLORS.accent : COLORS.border}`,
                background: mode === m ? COLORS.accent : 'transparent',
                color: mode === m ? 'var(--on-accent)' : COLORS.text,
              }}
            >
              {t(MODE_LABEL[m])}
            </button>
          ))}
        </div>
        {mode === 'codex-local' && (
          <p style={{ ...TYPE.meta, color: COLORS.muted, margin: '0 0 10px' }}>{t('mobile.spawnLocalModel', { model: localModel })}</p>
        )}
        {agent && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 16, cursor: 'pointer' }}>
            <input type="checkbox" checked={skip} onChange={toggleSkip} style={{ width: 18, height: 18, marginTop: 2 }} />
            <span style={{ ...TYPE.meta, color: COLORS.text }}>
              {t('terminal.skipPermissions')}
              {skip && (
                <span style={{ display: 'block', color: COLORS.muted }}>
                  {t(mode === 'claude' ? 'terminal.skipPermissionsWarning' : 'terminal.launch.codexSkipWarning')}
                </span>
              )}
            </span>
          </label>
        )}

        {sections.length === 0 && (
          <p style={{ fontSize: 13, color: COLORS.muted, lineHeight: 1.6 }}>{t('mobile.noProjects')}</p>
        )}
        {sections.map((section) => (
          <div key={section.key} style={{ marginBottom: 14 }}>
            <span style={label}>{section.title}</span>
            {section.items.map((project) => (
              <button
                key={project.path}
                aria-label={project.name}
                onClick={() => start(project.path)}
                style={{
                  display: 'block', width: '100%', minHeight: 52, padding: '8px 14px', marginBottom: 6,
                  borderRadius: 10, textAlign: 'left', cursor: 'pointer',
                  border: `1px solid ${COLORS.border}`, background: COLORS.surface, color: COLORS.text,
                }}
              >
                <span style={{ display: 'block', fontSize: 15, fontWeight: 600 }}>{project.name}</span>
                <span style={{ display: 'block', ...TYPE.meta, ...clamp1, color: COLORS.muted }}>{pathTail(project.path)}</span>
              </button>
            ))}
          </div>
        ))}

        <span style={label}>{t('mobile.spawnManual')}</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="/Users/me/work/app"
            aria-label={t('mobile.spawnManual')}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            style={{ ...input, flex: 1 }}
          />
          <button
            style={{ ...primaryButton, width: 'auto', padding: '0 16px', opacity: manual.trim() ? 1 : 0.5 }}
            disabled={!manual.trim()}
            onClick={() => start(manual.trim())}
          >
            {t('mobile.spawnStart')}
          </button>
        </div>
      </div>
    </div>
  );
}
