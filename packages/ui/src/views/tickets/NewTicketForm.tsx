import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { SshTarget, TicketLocation } from '@open-alive/core';
import type { TicketCreateFn } from './useTickets.ts';
import { FolderPicker } from './FolderPicker.tsx';
import { RemoteFolderPicker } from './RemoteFolderPicker.tsx';
import { loadPresets, presetTarget as targetOf, SSH_PRESETS_CHANGED, type SSHPreset } from '../chat/sshPresets.ts';

import { useClaudeModels } from '../../hooks/useClaudeModels.ts';
import { ModelPicker, EffortPicker, isClaudeChoice, type EffortLevel } from './ModelPicker.tsx';
import { useCodexModels } from '../../hooks/useCodexModels.ts';
import { ModelBadge } from '../../components/ModelBadge.tsx';
import { Chevron } from '../../components/Chevron.tsx';
import { BranchPicker } from './BranchPicker.tsx';

interface NewTicketFormProps {
  /**
   * Working directory chosen elsewhere (the sidebar's per-worktree "+"). It
   * seeds the folder picker so starting a run from a branch skips the picker.
   */
  presetCwd?: string;
  /**
   * The machine that path is on, when the sidebar knows it.
   *
   * A remote root is just a string, and handing one to a local agent is how a
   * ticket ended up pointed at a path that does not exist here. The path and
   * the host travel together or not at all.
   */
  presetLocation?: TicketLocation;
  /** Folders sessions are running in now — the folder picker's quick select. */
  activeFolders?: readonly string[];
  onCreate: TicketCreateFn;
}

/** Location id used when the sidebar's host is not among the saved presets. */
const SIDEBAR_LOCATION = '__sidebar__';

function pathBasename(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;
}

/** `dev@host` / `host:port` — inlined (avoid a core runtime import in the browser bundle). */
function sshDisplay(t: SshTarget): string {
  const at = t.user ? `${t.user}@${t.host}` : t.host;
  return t.port && t.port !== 22 ? `${at}:${t.port}` : at;
}

const OPTIONS_OPEN_KEY = 'open-alive:ticket-options-open';

/**
 * Presets usable as a ticket location, with their target filled in — including
 * free-form `ssh …` presets made in the terminal's SSH tab.
 */
function ticketHosts(): Array<SSHPreset & { host: string }> {
  return loadPresets().flatMap((p) => {
    const target = targetOf(p);
    return target ? [{ ...p, ...target }] : [];
  });
}

/** Same host, same user, same port — a preset that can execute this location. */
function matchesTarget(preset: { host?: string; user?: string; port?: number }, t: SshTarget): boolean {
  return preset.host === t.host
    && (preset.user ?? undefined) === (t.user ?? undefined)
    && (preset.port ?? 22) === (t.port ?? 22);
}

export function NewTicketForm({ onCreate, presetCwd, presetLocation, activeFolders = [] }: NewTicketFormProps) {
  const { t } = useTranslation();
  const claudeModels = useClaudeModels();
  const codexModels = useCodexModels();
  const [goal, setGoal] = useState('');
  const [cwd, setCwd] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [remotePickerOpen, setRemotePickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Presets with a resolvable SSH target can be a ticket location (headless SSH
  // needs the host server-side); a preset that runs a remote command stays terminal-only.
  const [sshHosts, setSshHosts] = useState(ticketHosts);
  // Refresh the location picker when SSH hosts are added/removed elsewhere (e.g. the
  // Backends onboarding screen) — the form stays mounted, so re-read on the event.
  useEffect(() => {
    const onChange = () => setSshHosts(ticketHosts());
    window.addEventListener(SSH_PRESETS_CHANGED, onChange);
    return () => window.removeEventListener(SSH_PRESETS_CHANGED, onChange);
  }, []);
  const [locId, setLocId] = useState('local');

  // A newly supplied preset wins over whatever the picker held; the user just
  // asked for that worktree explicitly. The host moves with it: a remote root
  // selected while the composer said "Local" was submitted as a local run and
  // failed on a path this machine does not have.
  const presetTarget = presetLocation?.kind === 'ssh' ? presetLocation.ssh : undefined;
  const presetKey = presetTarget ? sshDisplay(presetTarget) : 'local';
  useEffect(() => {
    if (!presetCwd) return;
    setCwd(presetCwd);
    setError(null);
    if (!presetTarget) {
      setLocId('local');
      return;
    }
    const known = ticketHosts().find((p) => matchesTarget(p, presetTarget));
    setLocId(known ? known.id : SIDEBAR_LOCATION);
    // presetKey stands in for presetTarget: re-running on every new object
    // identity would fight the user's own choice of location.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetCwd, presetKey]);
  // Default ON: orchestrated runs are the normal way tickets are executed here,
  // so the checkbox starts checked and stays a one-click opt-out.
  const [orchestrated, setOrchestrated] = useState(true);
  // Default ON: a verified ticket that is not committed gets absorbed into the
  // next ticket's diff, which is what makes per-ticket review impossible.
  const [autoCommit, setAutoCommit] = useState(true);
  // Default ON. Turning it off keeps the ticket's goal and report off the
  // third-party gateway; the local Claude gate still runs.
  const [panelReview, setPanelReview] = useState(true);
  // Which model/effort the agent runs with. `standard` reproduces the behaviour
  // tickets had before presets existed, so the default changes nothing.
  // '' = the default tier (Opus), resolved to its current id below.
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<EffortLevel>('high');
  // Options fold away by default; the choice to show them is remembered.
  const [optionsOpen, setOptionsOpenState] = useState(() => {
    try {
      return localStorage.getItem(OPTIONS_OPEN_KEY) === '1';
    } catch {
      return false;
    }
  });
  const setOptionsOpen = (open: boolean) => {
    setOptionsOpenState(open);
    try {
      localStorage.setItem(OPTIONS_OPEN_KEY, open ? '1' : '0');
    } catch {
      // storage disabled: not remembered
    }
  };
  const chosenModel = model || claudeModels.opus;
  const isCodex = !isClaudeChoice(chosenModel);
  const codexChoice = isCodex ? codexModels.find((m) => m.id === chosenModel) : undefined;
  // The sidebar's option exists only while the sidebar is offering one; falling
  // back to Local keeps the select from rendering a blank value after the
  // selection is cleared.
  const effectiveLocId = locId === SIDEBAR_LOCATION && presetLocation === undefined ? 'local' : locId;
  const preset = sshHosts.find((p) => p.id === effectiveLocId);
  // The sidebar can name a host that was never saved as a preset (it comes from
  // the run registry, not from localStorage). That location is still executable
  // — the server only needs the target — so it is offered as its own option
  // rather than silently downgraded to Local.
  const usingSidebar = effectiveLocId === SIDEBAR_LOCATION;

  const location: TicketLocation | undefined = preset
    ? {
        kind: 'ssh',
        ssh: { host: preset.host, user: preset.user, port: preset.port, identityFile: preset.identityFile },
        label: preset.label,
      }
    : usingSidebar
      ? presetLocation
      : undefined;
  const isRemote = location !== undefined;

  const canSubmit = goal.trim().length > 0 && cwd.length > 0 && !submitting;

  const submit = async () => {
    // Codex runs on this machine only; the form shows why instead of submitting.
    if (!canSubmit || (isRemote && isCodex)) return;
    setSubmitting(true);
    // Orchestrator mode delegates to sub-agents; only meaningful for local runs.
    const err = await onCreate(goal.trim(), cwd, location, orchestrated && !isRemote, undefined, autoCommit, panelReview, { model: chosenModel, effort });
    setSubmitting(false);
    if (err) {
      setError(err); // surface the server's specific reason (e.g. bad cwd)
      return;
    }
    setError(null);
    setGoal(''); // keep cwd for the next ticket in the same project
  };

  return (
    <div
      style={{
        background: 'var(--bg-secondary, #161b22)',
        border: '1px solid var(--border-default, #30363d)',
        borderRadius: 12,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <textarea
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        placeholder={t('tickets.newGoalPlaceholder')}
        rows={2}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit();
        }}
        style={{
          resize: 'vertical',
          fontSize: 14,
          fontFamily: 'var(--font-ui, system-ui)',
          padding: 10,
          borderRadius: 8,
          border: '1px solid var(--border-default, #30363d)',
          background: 'var(--bg-primary, #0d1117)',
          color: 'var(--text-primary, #e6edf3)',
        }}
      />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        {/* Execution location: Local, or a registered SSH host (headless claude
            over SSH). Shown only when host-bearing presets exist. */}
        {(sshHosts.length > 0 || usingSidebar) && (
          <div style={{ position: 'relative', flexShrink: 0, display: 'flex' }}>
          <select
            value={effectiveLocId}
            onChange={(e) => {
              setLocId(e.target.value);
              setCwd(''); // local path vs remote path are not interchangeable
              setError(null);
            }}
            title={t('tickets.location')}
            style={{
              fontSize: 12,
              padding: '8px 10px',
              borderRadius: 8,
              border: '1px solid var(--border-default, #30363d)',
              background: 'var(--bg-primary, #0d1117)',
              color: 'var(--text-primary, #e6edf3)',
              cursor: 'pointer',
              maxWidth: 170,
              // Native caret replaced by the shared Chevron below.
              appearance: 'none',
              WebkitAppearance: 'none',
              paddingRight: 28,
            }}
          >
            <option value="local">{t('tickets.locationLocal')}</option>
            {sshHosts.map((p) => (
              <option key={p.id} value={p.id}>
                ⬈ {p.label}
              </option>
            ))}
            {usingSidebar && presetTarget && (
              <option value={SIDEBAR_LOCATION}>
                ⬈ {presetLocation?.label || sshDisplay(presetTarget)}
              </option>
            )}
          </select>
          <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--text-secondary, #8b949e)', display: 'flex' }}>
            <Chevron direction="down" />
          </span>
          </div>
        )}
        {/* Local and SSH pick the folder the same way: click → folder picker
            (the SSH one browses the host). No free-text path field. */}
          <button
            type="button"
            onClick={() => (isRemote ? setRemotePickerOpen(true) : setPickerOpen(true))}
            title={cwd || (isRemote ? t('tickets.remotePickerTitle') : t('tickets.selectFolder'))}
            data-testid="ticket-folder-button"
            style={{
              flex: '0 1 320px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              minWidth: 0,
              fontSize: 12,
              padding: '8px 10px',
              borderRadius: 8,
              border: '1px solid var(--border-default, #30363d)',
              background: 'var(--bg-primary, #0d1117)',
              color: cwd ? 'var(--text-primary, #e6edf3)' : 'var(--text-secondary, #8b949e)',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span style={{ opacity: 0.6, flexShrink: 0 }}>📁</span>
            {cwd ? (
              <>
                <span style={{ fontWeight: 600, flexShrink: 0 }}>{pathBasename(cwd)}</span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono, monospace)',
                    fontSize: 10,
                    color: 'var(--text-secondary, #8b949e)',
                    opacity: 0.5,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                  }}
                >
                  {cwd}
                </span>
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--accent-blue, #58a6ff)', flexShrink: 0 }}>
                  {t('tickets.changeFolder')}
                </span>
              </>
            ) : (
              <span>{t('tickets.selectFolder')}</span>
            )}
          </button>
        {/* Options: folded into a one-line summary next to the folder; expanding
            slides the details open below. */}
        <button
          type="button"
          aria-expanded={optionsOpen}
          aria-controls="ticket-options"
          data-testid="ticket-options-toggle"
          onClick={() => setOptionsOpen(!optionsOpen)}
          style={{
            flex: '1 1 auto',
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 10px',
            borderRadius: 8,
            border: '1px solid transparent',
            background: 'transparent',
            cursor: 'pointer',
            fontSize: 12,
            color: 'var(--text-secondary, #8b949e)',
            overflow: 'hidden',
          }}
        >
          <Chevron open={optionsOpen} />
          <span style={{ fontWeight: 600, flexShrink: 0 }}>{t('tickets.options')}</span>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              minWidth: 0,
              opacity: optionsOpen ? 0 : 1,
              transition: 'opacity 200ms ease',
            }}
          >
            <ModelBadge model={chosenModel} size={12} raw={isCodex} />
            <span style={{ fontFamily: 'var(--font-mono, monospace)', flexShrink: 0 }}>· {effort}</span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          style={{
            fontSize: 13,
            fontWeight: 600,
            padding: '8px 16px',
            borderRadius: 8,
            border: 'none',
            background: canSubmit ? 'var(--accent-blue, #58a6ff)' : 'var(--bg-tertiary, #21262d)',
            color: canSubmit ? 'var(--on-accent)' : 'var(--text-secondary, #8b949e)',
            cursor: canSubmit ? 'pointer' : 'not-allowed',
            whiteSpace: 'nowrap',
          }}
        >
          {submitting ? t('tickets.creating') : t('tickets.create')}
        </button>
      </div>
      {/* The host is not a detail to bury in a dropdown: this is the line that
          says a run will leave this machine. */}
      {isRemote && location?.ssh && (
        <div
          data-testid="ticket-remote-note"
          style={{ fontSize: 11, fontFamily: 'var(--font-mono, monospace)', color: 'var(--accent-purple, #bc8cff)' }}
        >
          ⬈ {t('tickets.runsOn', { target: sshDisplay(location.ssh) })}
        </div>
      )}
      {isRemote && isCodex && <div role="alert" style={{ fontSize: 11, color: 'var(--accent-red)' }}>{t('tickets.model.codexLocalOnly')}</div>}
      {/* Grid-row 0fr → 1fr animates to the content's own height, so the
          details unfold over ~0.3s instead of appearing at once. */}
      <div
        id="ticket-options"
        data-testid="ticket-options"
        aria-hidden={!optionsOpen}
        // inert: folded options must not take focus or clicks
        {...(!optionsOpen ? { inert: true } : {})}
        style={{
          display: 'grid',
          gridTemplateRows: optionsOpen ? '1fr' : '0fr',
          opacity: optionsOpen ? 1 : 0,
          transition: 'grid-template-rows 320ms ease, opacity 260ms ease',
        }}
      >
        <div style={{ overflow: 'hidden', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10, paddingTop: optionsOpen ? 2 : 0 }}>
        {/* Which branch the run happens on. Local only: a remote checkout is not
            ours to move, and the hooks that would report the change are local. */}
        {!isRemote && cwd.length > 0 && <BranchPicker cwd={cwd} />}
        {/* Model and run profile (effort) are chosen independently. */}
        <ModelPicker models={claudeModels} codexModels={isRemote ? [] : codexModels} value={chosenModel} onChange={setModel} />
        <EffortPicker value={effort} onChange={setEffort} supported={codexChoice?.efforts ?? []} />
        {!isRemote && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary, #8b949e)', cursor: 'pointer', userSelect: 'none' }}>
            <input type="checkbox" checked={orchestrated} onChange={(e) => setOrchestrated(e.target.checked)} style={{ cursor: 'pointer' }} />
            <span>{t('tickets.orchestrate')}</span>
            <span style={{ opacity: 0.6 }}>{t('tickets.orchestrateHint')}</span>
          </label>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary, #8b949e)', cursor: 'pointer', userSelect: 'none' }}>
          <input type="checkbox" checked={autoCommit} onChange={(e) => setAutoCommit(e.target.checked)} style={{ cursor: 'pointer' }} />
          <span>{t('tickets.autoCommit')}</span>
          <span style={{ opacity: 0.6 }}>{isRemote ? t('tickets.autoCommitRemoteHint') : t('tickets.autoCommitHint')}</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary, #8b949e)', cursor: 'pointer', userSelect: 'none' }}>
          <input type="checkbox" checked={panelReview} onChange={(e) => setPanelReview(e.target.checked)} style={{ cursor: 'pointer' }} />
          <span>{t('tickets.panelReview')}</span>
          <span style={{ opacity: 0.6 }}>{t('tickets.panelReviewHint')}</span>
        </label>
        </div>
      </div>
      {error && (
        <div style={{ fontSize: 12, color: 'var(--accent-red, #f85149)', lineHeight: 1.5 }}>{error}</div>
      )}
      {pickerOpen && (
        <FolderPicker
          quick={activeFolders}
          onSelect={(path) => {
            setCwd(path);
            setError(null);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
      {remotePickerOpen && location?.ssh && (
        <RemoteFolderPicker
          ssh={location.ssh}
          onSelect={(path) => {
            setCwd(path);
            setError(null);
          }}
          onClose={() => setRemotePickerOpen(false)}
        />
      )}
    </div>
  );
}
