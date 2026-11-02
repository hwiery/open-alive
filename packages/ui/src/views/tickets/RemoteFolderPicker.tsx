import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SshTarget } from '@open-alive/core';
import { loadRecentFolders, pushRecentFolder, removeRecentFolder } from '../chat/recentFolders.ts';
import { FolderColumns } from '../chat/FolderColumns.tsx';
import { FolderPickerDialog } from './FolderPickerDialog.tsx';

/**
 * Remote (SSH) folder picker for the ticket form. Browses the remote host's
 * directories via `POST /api/ssh/browse` (the server runs `ssh host ls`), so an
 * SSH ticket gets a real, server-validated remote absolute path instead of a
 * hand-typed one.
 *
 * Mirrors the local `FolderPicker` design 1:1 (same dialog and columns, with no
 * quick-select column: running sessions are local paths). Recent history is namespaced per host (`user@host:port`)
 * so a remote path is never offered as a shortcut on the wrong machine.
 */
const API_BASE = `${window.location.protocol}//${window.location.hostname}:${window.location.port || '3141'}`;

interface RemoteFolderPickerProps {
  ssh: SshTarget;
  onSelect: (absPath: string) => void;
  onClose: () => void;
}

export function RemoteFolderPicker({ ssh, onSelect, onClose }: RemoteFolderPickerProps) {
  const { t } = useTranslation();
  // Depend on the primitive fields, not the `ssh` object — the parent passes a
  // fresh object literal each render, which would otherwise recreate `browse`
  // and loop the effect (perpetual loading).
  const { host, user, port, identityFile } = ssh;
  // Per-host recents namespace: the same absolute path means different folders
  // on different machines, so each host keeps its own shortcut history.
  const scope = `${user ?? ''}@${host}:${port ?? 22}`;

  const [path, setPath] = useState('');
  const [dirs, setDirs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(() => loadRecentFolders(scope));

  const browse = useCallback(
    (target?: string) => {
      setLoading(true);
      setError(null);
      fetch(`${API_BASE}/api/ssh/browse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ssh: { host, user, port, identityFile }, path: target }),
      })
        .then((r) => r.json())
        .then((data: { path?: string; dirs?: string[]; error?: string }) => {
          if (data.error) {
            setError(data.error);
            return;
          }
          setPath(data.path ?? '');
          setDirs(data.dirs ?? []);
        })
        .catch(() => setError('connection failed'))
        .finally(() => setLoading(false));
    },
    [host, user, port, identityFile],
  );

  useEffect(() => {
    browse(undefined); // home
  }, [browse]);

  const pick = useCallback(
    (p: string) => {
      if (!p) return;
      setRecent(pushRecentFolder(p, scope));
      onSelect(p);
      onClose();
    },
    [onSelect, onClose, scope],
  );

  const join = (base: string, name: string) => `${base.replace(/\/$/, '')}/${name}`;

  return (
    <FolderPickerDialog
      title={
        <>
          {t('tickets.remotePickerTitle')}{' '}
          <span style={{ color: 'var(--accent-purple)' }}>⬈ {ssh.user ? `${ssh.user}@${ssh.host}` : ssh.host}</span>
        </>
      }
      currentPath={path}
      onPick={pick}
      onClose={onClose}
    >
      <FolderColumns
        recent={recent}
        onRemoveRecent={(p) => setRecent(removeRecentFolder(p, scope))}
        onPick={pick}
        browsePath={path}
        browseDirs={dirs.map((name) => ({ name, path: join(path, name) }))}
        browseLoading={loading}
        browseError={error}
        onBrowse={browse}
      />
    </FolderPickerDialog>
  );
}
