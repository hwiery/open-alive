import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SshTarget, TicketLocation } from '@open-alive/core';
import { loadPresets, presetTarget, SSH_PRESETS_CHANGED } from '../views/chat/sshPresets.ts';
import { modelLabel } from '../views/tickets/runPresets.ts';
import { EFFORT_LEVELS, type EffortLevel } from '../views/tickets/ModelPicker.tsx';
import { useClaudeModels } from '../hooks/useClaudeModels.ts';
import { useCodexModels } from '../hooks/useCodexModels.ts';
import { ModelLogo } from '../components/ModelBadge.tsx';
import { COLORS, screen, topBar, body, primaryButton, secondaryButton, actionBar, input, label } from './styles.ts';
import { Panel, Badge } from './parts.tsx';
import type { MobileProject, MobileCreateFn } from './types.ts';

const API_BASE = `${window.location.protocol}//${window.location.hostname}:${window.location.port || '3141'}`;

export type { MobileProject };

export interface MobileTicketComposeProps {
  projects: MobileProject[];
  onCancel: () => void;
  onCreate: MobileCreateFn;
}

function sshDisplay(target: SshTarget): string {
  const at = target.user ? `${target.user}@${target.host}` : target.host;
  return target.port && target.port !== 22 ? `${at}:${target.port}` : at;
}

/** Slides up from the bottom — the phone equivalent of the desktop folder dialog. */
function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'flex-end' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxHeight: '70vh', background: COLORS.bg,
          borderTop: `1px solid ${COLORS.border}`, borderRadius: '14px 14px 0 0',
          display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ ...topBar, borderBottom: `1px solid ${COLORS.border}` }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>{title}</span>
          <button onClick={onClose} style={{ ...secondaryButton, marginLeft: 'auto', padding: '0 12px' }}>
            {t('mobile.sheetClose')}
          </button>
        </div>
        <div style={{ overflowY: 'auto', padding: 12, paddingBottom: 'calc(12px + env(safe-area-inset-bottom))' }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function Toggle({ text, hint, on, onChange }: { text: string; hint: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={text}
      onClick={() => onChange(!on)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 48,
        padding: '0 12px', marginBottom: 6, borderRadius: 10, cursor: 'pointer', textAlign: 'left',
        border: `1px solid ${COLORS.border}`, background: COLORS.surface, color: COLORS.text,
      }}
    >
      <span
        style={{
          width: 36, height: 20, borderRadius: 999, flexShrink: 0, position: 'relative',
          background: on ? COLORS.accent : COLORS.border,
        }}
      >
        <span style={{ position: 'absolute', top: 2, left: on ? 18 : 2, width: 16, height: 16, borderRadius: 999, background: 'var(--on-accent)' }} />
      </span>
      <span style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{ fontSize: 14 }}>{text}</span>
        <span style={{ fontSize: 11, color: COLORS.muted }}>{hint}</span>
      </span>
    </button>
  );
}

/**
 * The desktop composer at phone width: goal, where it runs, which branch, how
 * deep, and the three run switches — then Solve.
 *
 * Folder and host selection open as bottom sheets rather than inline lists: on
 * a 390px screen an expanded list of 33 projects pushes Solve off the bottom,
 * and the choice is a moment, not part of the form.
 */
export function MobileTicketCompose({ projects, onCancel, onCreate }: MobileTicketComposeProps) {
  const { t } = useTranslation();
  const [goal, setGoal] = useState('');
  const [cwd, setCwd] = useState(projects.length === 1 ? projects[0]!.path : '');
  const [remotePath, setRemotePath] = useState('');
  const [locId, setLocId] = useState('local');
  const claudeModels = useClaudeModels();
  const codexModels = useCodexModels();
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<EffortLevel>('high');
  const [orchestrated, setOrchestrated] = useState(true);
  const [autoCommit, setAutoCommit] = useState(true);
  const [panelReview, setPanelReview] = useState(true);
  const [branches, setBranches] = useState<{ current?: string; branches: string[] }>({ branches: [] });
  const [sheet, setSheet] = useState<'folder' | 'host' | 'branch' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [sshHosts, setSshHosts] = useState(() => loadPresets().flatMap((p) => { const target = presetTarget(p); return target ? [{ ...p, ...target }] : []; }));
  useEffect(() => {
    const onChange = () => setSshHosts(loadPresets().flatMap((p) => { const target = presetTarget(p); return target ? [{ ...p, ...target }] : []; }));
    window.addEventListener(SSH_PRESETS_CHANGED, onChange);
    return () => window.removeEventListener(SSH_PRESETS_CHANGED, onChange);
  }, []);

  const host = useMemo(() => sshHosts.find((p) => p.id === locId), [sshHosts, locId]);
  const isRemote = locId !== 'local' && host !== undefined;
  const effectiveCwd = isRemote ? remotePath.trim() : cwd;
  // Claude tiers always; Codex models only for a local run (Codex never runs over SSH).
  const modelOptions = useMemo(
    () => [
      ...(['haiku', 'sonnet', 'opus', 'fable'] as const).map((tier) => ({ id: claudeModels[tier], label: modelLabel(claudeModels[tier]) ?? claudeModels[tier] })),
      ...(isRemote ? [] : codexModels.filter((m) => m.listed).map((m) => ({ id: m.id, label: m.label }))),
    ],
    [claudeModels, codexModels, isRemote],
  );
  const chosenModel = modelOptions.some((m) => m.id === model) ? model : claudeModels.opus;

  // Branches come from the allowlisted endpoint, not a filesystem walk: a
  // device may not browse the disk, so this is the only branch source it has.
  useEffect(() => {
    if (isRemote || !cwd) {
      setBranches({ branches: [] });
      return;
    }
    let stop = false;
    fetch(`${API_BASE}/api/remote/branches?cwd=${encodeURIComponent(cwd)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { current?: string; branches?: string[] } | null) => {
        if (!stop && data) setBranches({ current: data.current, branches: data.branches ?? [] });
      })
      .catch(() => { /* branch display is optional */ });
    return () => { stop = true; };
  }, [cwd, isRemote]);

  const ready = goal.trim().length > 0 && effectiveCwd.length > 0 && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const location: TicketLocation | undefined =
      isRemote && host ? { kind: 'ssh', ssh: host as SshTarget, label: sshDisplay(host as SshTarget) } : undefined;
    const message = await onCreate({
      goal: goal.trim(), cwd: effectiveCwd, location, orchestrated, model: chosenModel, effort, autoCommit, panelReview,
    });
    setBusy(false);
    if (message) setError(message);
    else onCancel();
  };

  const folderName = cwd ? projects.find((p) => p.path === cwd)?.name ?? cwd : '';

  return (
    <div style={screen}>
      <div style={topBar}>
        <button
          onClick={onCancel}
          aria-label={t('mobile.back')}
          style={{ background: 'none', border: 'none', color: COLORS.text, fontSize: 22, lineHeight: 1, cursor: 'pointer', padding: '0 6px 0 0' }}
        >
          ‹
        </button>
        <span style={{ fontSize: 17, fontWeight: 600 }}>{t('mobile.composeTitle')}</span>
      </div>

      <div style={{ ...body, paddingBottom: 96 }}>
        <textarea
          value={goal}
          rows={5}
          placeholder={t('tickets.newGoalPlaceholder')}
          onChange={(e) => setGoal(e.target.value)}
          style={{ ...input, resize: 'vertical', lineHeight: 1.5 }}
        />

        <div style={{ height: 18 }} />
        <span style={label}>{t('tickets.location')}</span>
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          <button
            role="radio"
            aria-checked={!isRemote}
            aria-label={t('mobile.locationLocal')}
            onClick={() => setLocId('local')}
            style={{
              ...secondaryButton, flex: 1, minHeight: 44,
              borderColor: !isRemote ? COLORS.accent : COLORS.border,
              background: !isRemote ? COLORS.accent : 'transparent',
              color: !isRemote ? 'var(--on-accent)' : COLORS.text,
            }}
          >
            {t('mobile.locationLocal')}
          </button>
          <button
            role="radio"
            aria-checked={isRemote}
            aria-label={t('mobile.locationSsh')}
            onClick={() => setSheet('host')}
            style={{
              ...secondaryButton, flex: 1, minHeight: 44,
              borderColor: isRemote ? 'var(--accent-purple)' : COLORS.border,
              background: isRemote ? 'var(--accent-purple)' : 'transparent',
              color: isRemote ? 'var(--on-accent)' : COLORS.text,
            }}
          >
            {isRemote && host ? sshDisplay(host as SshTarget) : t('mobile.locationSsh')}
          </button>
        </div>

        {isRemote ? (
          <input
            value={remotePath}
            placeholder={t('tickets.remotePathPlaceholder')}
            onChange={(e) => setRemotePath(e.target.value)}
            style={input}
          />
        ) : (
          <button onClick={() => setSheet('folder')} style={{ ...secondaryButton, width: '100%', minHeight: 48, textAlign: 'left', padding: '0 14px' }}>
            {folderName || t('tickets.selectFolder')}
          </button>
        )}

        {!isRemote && branches.branches.length > 0 && (
          <>
            <div style={{ height: 14 }} />
            <span style={label}>{t('mobile.branchLabel')}</span>
            <button onClick={() => setSheet('branch')} style={{ ...secondaryButton, width: '100%', minHeight: 44, textAlign: 'left', padding: '0 14px' }}>
              {branches.current ?? t('mobile.branchLabel')}
            </button>
          </>
        )}

        <div style={{ height: 18 }} />
        <span style={label}>{t('tickets.model.label')}</span>
        <div role="radiogroup" aria-label={t('tickets.model.label')} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {modelOptions.map((m) => (
            <button
              key={m.id}
              role="radio"
              aria-checked={chosenModel === m.id}
              aria-label={m.label}
              onClick={() => setModel(m.id)}
              style={{
                ...secondaryButton, minHeight: 44, padding: '0 12px', fontSize: 14,
                display: 'inline-flex', alignItems: 'center', gap: 6,
                borderColor: chosenModel === m.id ? COLORS.accent : COLORS.border,
                background: chosenModel === m.id ? COLORS.accent : 'transparent',
                color: chosenModel === m.id ? 'var(--on-accent)' : COLORS.text,
              }}
            >
              <ModelLogo model={m.id} size={14} />
              {m.label}
            </button>
          ))}
        </div>

        <div style={{ height: 18 }} />
        <span style={label}>{t('tickets.presetLabel')}</span>
        <div role="radiogroup" aria-label={t('tickets.presetLabel')} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {EFFORT_LEVELS.map((e) => (
            <button
              key={e}
              role="radio"
              aria-checked={effort === e}
              aria-label={e}
              onClick={() => setEffort(e)}
              style={{
                ...secondaryButton, minHeight: 44, padding: '0 14px', fontSize: 14,
                borderColor: effort === e ? COLORS.accent : COLORS.border,
                background: effort === e ? COLORS.accent : 'transparent',
                color: effort === e ? 'var(--on-accent)' : COLORS.text,
              }}
            >
              {e}
            </button>
          ))}
        </div>

        <div style={{ height: 18 }} />
        <span style={label}>{t('mobile.settingsLabel')}</span>
        <Toggle text={t('tickets.orchestrate')} hint={t('tickets.orchestrateHint')} on={orchestrated} onChange={setOrchestrated} />
        <Toggle
          text={t('tickets.autoCommit')}
          hint={isRemote ? t('tickets.autoCommitRemoteHint') : t('tickets.autoCommitHint')}
          on={autoCommit}
          onChange={setAutoCommit}
        />
        <Toggle text={t('tickets.panelReview')} hint={t('tickets.panelReviewHint')} on={panelReview} onChange={setPanelReview} />

        {error && <p style={{ marginTop: 14, fontSize: 13, color: 'var(--accent-red)', lineHeight: 1.5 }}>{error}</p>}
      </div>

      <div style={actionBar}>
        <button style={{ ...primaryButton, opacity: ready ? 1 : 0.4 }} disabled={!ready} onClick={submit}>
          {busy ? t('tickets.creating') : t('tickets.create')}
        </button>
      </div>

      {sheet === 'folder' && (
        <Sheet title={t('mobile.pickFolder')} onClose={() => setSheet(null)}>
          {projects.length === 0 ? (
            <Panel>{t('mobile.noProjects')}</Panel>
          ) : (
            projects.map((project) => (
              <button
                key={project.path}
                aria-label={project.name}
                onClick={() => { setCwd(project.path); setSheet(null); }}
                style={{
                  display: 'block', width: '100%', minHeight: 48, padding: '0 14px', marginBottom: 6,
                  borderRadius: 10, textAlign: 'left', cursor: 'pointer', fontSize: 15,
                  border: `1px solid ${cwd === project.path ? COLORS.accent : COLORS.border}`,
                  background: COLORS.surface, color: COLORS.text,
                }}
              >
                {project.name}
              </button>
            ))
          )}
        </Sheet>
      )}

      {sheet === 'host' && (
        <Sheet title={t('tickets.location')} onClose={() => setSheet(null)}>
          <button
            aria-label={t('mobile.locationLocal')}
            onClick={() => { setLocId('local'); setSheet(null); }}
            style={{ display: 'block', width: '100%', minHeight: 48, padding: '0 14px', marginBottom: 6, borderRadius: 10, textAlign: 'left', cursor: 'pointer', fontSize: 15, border: `1px solid ${COLORS.border}`, background: COLORS.surface, color: COLORS.text }}
          >
            {t('mobile.locationLocal')}
          </button>
          {sshHosts.length === 0 ? (
            <Panel>{t('tickets.remotePickerTitle')}</Panel>
          ) : (
            sshHosts.map((p) => (
              <button
                key={p.id}
                aria-label={sshDisplay(p as SshTarget)}
                onClick={() => { setLocId(p.id); setSheet(null); }}
                style={{ display: 'block', width: '100%', minHeight: 48, padding: '0 14px', marginBottom: 6, borderRadius: 10, textAlign: 'left', cursor: 'pointer', fontSize: 15, border: `1px solid ${locId === p.id ? 'var(--accent-purple)' : COLORS.border}`, background: COLORS.surface, color: COLORS.text }}
              >
                {sshDisplay(p as SshTarget)}
              </button>
            ))
          )}
        </Sheet>
      )}

      {sheet === 'branch' && (
        <Sheet title={t('mobile.branchLabel')} onClose={() => setSheet(null)}>
          {branches.branches.map((branch) => (
            <div
              key={branch}
              style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, padding: '0 14px', marginBottom: 6, borderRadius: 10, border: `1px solid ${COLORS.border}`, background: COLORS.surface, fontSize: 15 }}
            >
              {branch}
              {branch === branches.current && <Badge text="HEAD" color={COLORS.accent} />}
            </div>
          ))}
        </Sheet>
      )}
    </div>
  );
}
