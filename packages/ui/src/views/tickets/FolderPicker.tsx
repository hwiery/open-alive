import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { loadRecentFolders, pushRecentFolder, removeRecentFolder } from '../chat/recentFolders.ts';
import { FolderColumns } from '../chat/FolderColumns.tsx';
import { FolderPickerDialog } from './FolderPickerDialog.tsx';

/**
 * Local project-folder picker for the ticket form.
 *
 * Reuses the exact same logic and layout the terminal uses to choose a working
 * directory: the `/api/fs/browse` endpoint for directory navigation, the shared
 * `recentFolders` store, and the same quick select / recent / browse columns
 * (minus the typed-path box: every path here comes from the server's listing).
 * Selecting a folder yields a real, server-validated absolute path — so a
 * ticket never launches against a typo'd or non-existent cwd the way a
 * free-text input allowed.
 */

const API_BASE = `${window.location.protocol}//${window.location.hostname}:${window.location.port || '3141'}`;

interface FolderPickerProps {
  /** Folders sessions are running in right now (the terminal's quick select). Omitted → no such column. */
  quick?: readonly string[];
  /** Called with the chosen absolute path; the folder is also pushed to recents. */
  onSelect: (absPath: string) => void;
  onClose: () => void;
}

export function FolderPicker({ quick, onSelect, onClose }: FolderPickerProps) {
  const { t } = useTranslation();
  const [dirs, setDirs] = useState<{ name: string; path: string }[]>([]);
  const [currentPath, setCurrentPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [recent, setRecent] = useState<string[]>(() => loadRecentFolders());

  const browse = useCallback((dir: string) => {
    setLoading(true);
    fetch(`${API_BASE}/api/fs/browse?dir=${encodeURIComponent(dir)}`)
      .then((r) => r.json())
      .then((data: { path: string; dirs: { name: string; path: string }[] }) => {
        setCurrentPath(data.path);
        setDirs(data.dirs);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    browse('~');
  }, [browse]);

  const pick = useCallback(
    (path: string) => {
      if (!path) return;
      setRecent(pushRecentFolder(path));
      onSelect(path);
      onClose();
    },
    [onSelect, onClose],
  );

  return (
    <FolderPickerDialog title={t('tickets.pickerTitle')} currentPath={currentPath} onPick={pick} onClose={onClose}>
      <FolderColumns
        quick={quick}
        recent={recent}
        onRemoveRecent={(path) => setRecent(removeRecentFolder(path))}
        onPick={pick}
        browsePath={currentPath}
        browseDirs={dirs}
        browseLoading={loading}
        onBrowse={browse}
      />
    </FolderPickerDialog>
  );
}
