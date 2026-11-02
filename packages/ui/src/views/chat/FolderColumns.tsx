import { useTranslation } from 'react-i18next';

/**
 * The body of every folder-choosing dialog — the terminal's working-directory
 * picker and the ticket form's local/SSH folder pickers: quick select, recent
 * folders and browse side by side, each tall enough for 20+ rows. On a narrow
 * window the columns wrap and each keeps a usable height.
 *
 * Presentational only: the dialog owns where folders come from (local
 * `/api/fs/browse`, `ssh ls`, scoped recents) and what picking one does.
 */

export interface BrowseDir {
  name: string;
  path: string;
}

export interface FolderColumnsProps {
  /** Folders active right now. Omitted → no quick-select column. */
  quick?: readonly string[];
  recent: readonly string[];
  onRemoveRecent: (path: string) => void;
  onPick: (path: string) => void;
  browsePath: string;
  browseDirs: readonly BrowseDir[];
  browseLoading: boolean;
  /** Shown in place of the listing (e.g. an SSH failure). */
  browseError?: string | null;
  /** Navigate the browse column into `path`. */
  onBrowse: (path: string) => void;
  /** Typed-path entry under the listing; omitted → no input. */
  manualPath?: { value: string; onChange: (value: string) => void; onSubmit: (value: string) => void };
}

const columnStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  minWidth: 0,
  overflow: 'hidden',
  borderRight: '1px solid var(--border-color)',
  borderBottom: '1px solid var(--border-color)',
};
const sectionLabelStyle: React.CSSProperties = {
  padding: '8px 16px 4px',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--text-secondary)',
  opacity: 0.6,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  flexShrink: 0,
};
const listStyle: React.CSSProperties = { flex: 1, minHeight: 0, overflowY: 'auto' };
const rowStyle: React.CSSProperties = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 16px',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  textAlign: 'left',
  transition: 'background 0.15s ease',
  color: 'var(--text-primary)',
};
const pathStyle: React.CSSProperties = {
  fontSize: 10,
  color: 'var(--text-secondary)',
  opacity: 0.45,
  marginLeft: 'auto',
  fontFamily: 'var(--font-mono)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
  direction: 'rtl',
};
const emptyStyle: React.CSSProperties = {
  padding: 16,
  textAlign: 'center',
  fontSize: 12,
  color: 'var(--text-secondary)',
  opacity: 0.5,
};

function pathBasename(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;
}

const hoverOn = (e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.background = 'var(--hover)'; };
const hoverOff = (e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.background = 'transparent'; };

export function FolderColumns({
  quick,
  recent,
  onRemoveRecent,
  onPick,
  browsePath,
  browseDirs,
  browseLoading,
  browseError,
  onBrowse,
  manualPath,
}: FolderColumnsProps) {
  const { t } = useTranslation();
  const parent = browsePath.replace(/[\\/][^\\/]+[\\/]?$/, '') || '/';

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
        gridAutoRows: 'minmax(min(100%, 420px), 1fr)',
        overflowY: 'auto',
      }}
    >
      {quick && (
        <div style={columnStyle}>
          <div style={sectionLabelStyle}>{t('terminal.quickSelect')}</div>
          <div style={listStyle}>
            {quick.length === 0 ? (
              <div style={emptyStyle}>{t('terminal.noActiveProjects')}</div>
            ) : (
              quick.map((cwd) => (
                <button key={cwd} type="button" onClick={() => onPick(cwd)} title={cwd} style={rowStyle} onMouseEnter={hoverOn} onMouseLeave={hoverOff}>
                  <span style={{ fontSize: 12, opacity: 0.6, flexShrink: 0 }}>&#9733;</span>
                  <span style={{ fontSize: 13, fontWeight: 500, flexShrink: 0 }}>{pathBasename(cwd)}</span>
                  <span style={pathStyle}><span dir="ltr">{cwd}</span></span>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      <div style={columnStyle}>
        <div style={sectionLabelStyle}>{t('terminal.menu.recentFolders')}</div>
        <div style={listStyle}>
          {recent.length === 0 ? (
            <div style={emptyStyle}>{t('terminal.menu.noRecentFolders')}</div>
          ) : (
            recent.map((cwd) => (
              <div
                key={cwd}
                style={{ display: 'flex', alignItems: 'center', width: '100%', transition: 'background 0.15s ease' }}
                onMouseEnter={hoverOn}
                onMouseLeave={hoverOff}
              >
                <button
                  type="button"
                  onClick={() => onPick(cwd)}
                  title={cwd}
                  style={{ ...rowStyle, flex: 1, width: undefined, minWidth: 0 }}
                >
                  <span style={{ fontSize: 12, color: 'var(--accent-green)', flexShrink: 0 }}>⟲</span>
                  <span style={{ fontSize: 13, fontWeight: 500, flexShrink: 0 }}>{pathBasename(cwd)}</span>
                  <span style={pathStyle}><span dir="ltr">{cwd}</span></span>
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onRemoveRecent(cwd); }}
                  title={t('terminal.menu.removeRecentFolder')}
                  aria-label={t('terminal.menu.removeRecentFolder')}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-secondary)',
                    opacity: 0.4,
                    cursor: 'pointer',
                    fontSize: 12,
                    padding: '4px 12px',
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.9'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.4'; }}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Browse: directory navigation (+ optional typed path) */}
      <div style={{ ...columnStyle, borderRight: 'none' }}>
        {/* Section label + current path in one row, to leave the listing its height */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 16px 4px 0', borderBottom: '1px solid var(--border-color)', flexShrink: 0 }}>
          <span style={sectionLabelStyle}>{t('terminal.browseSection')}</span>
          {browsePath && browsePath !== '/' && (
            <button
              type="button"
              onClick={() => onBrowse(parent)}
              title={t('terminal.parentDir')}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                fontSize: 14,
                padding: '2px 6px',
                flexShrink: 0,
              }}
            >
              &#8592;
            </button>
          )}
          <div style={{
            flex: 1,
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            direction: 'rtl',
            textAlign: 'left',
          }}>
            <span dir="ltr">{browsePath}</span>
          </div>
        </div>

        {/* Click to enter, double-click to pick */}
        <div style={listStyle}>
          {browseLoading ? (
            <div style={emptyStyle}>...</div>
          ) : browseError ? (
            <div style={{ ...emptyStyle, color: 'var(--accent-red)', opacity: 1, lineHeight: 1.5 }}>{browseError}</div>
          ) : browseDirs.length === 0 ? (
            <div style={emptyStyle}>{t('terminal.emptyDir')}</div>
          ) : (
            browseDirs.map((dir) => (
              <button
                key={dir.path}
                type="button"
                onClick={() => onBrowse(dir.path)}
                onDoubleClick={() => onPick(dir.path)}
                title={dir.path}
                style={rowStyle}
                onMouseEnter={hoverOn}
                onMouseLeave={hoverOff}
              >
                <span style={{ opacity: 0.5, fontSize: 11, flexShrink: 0 }}>&#128193;</span>
                <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dir.name}</span>
              </button>
            ))
          )}
        </div>

        {manualPath && (
          <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border-color)' }}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const val = manualPath.value.trim();
                if (val) manualPath.onSubmit(val);
              }}
            >
              <input
                type="text"
                value={manualPath.value}
                onChange={(e) => manualPath.onChange(e.target.value)}
                placeholder={t('terminal.customPathPlaceholder')}
                style={{
                  width: '100%',
                  padding: '6px 10px',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 6,
                  color: 'var(--text-primary)',
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  outline: 'none',
                }}
                onFocus={(e) => { e.target.style.borderColor = 'var(--accent-blue)'; }}
                onBlur={(e) => { e.target.style.borderColor = 'var(--border-color)'; }}
              />
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
