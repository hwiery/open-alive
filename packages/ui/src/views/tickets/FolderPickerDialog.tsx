import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

/**
 * Frame shared by the ticket form's local and SSH folder pickers: the same
 * size as the terminal's working-directory dialog, a header, the
 * {@link FolderColumns} body, and a footer that picks the browsed folder.
 */
interface FolderPickerDialogProps {
  title: ReactNode;
  /** The folder the browse column is in; the footer button picks it. */
  currentPath: string;
  onPick: (path: string) => void;
  onClose: () => void;
  children: ReactNode;
}

export function FolderPickerDialog({ title, currentPath, onPick, onClose, children }: FolderPickerDialogProps) {
  const { t } = useTranslation();

  // Esc closes the picker only — capture phase, so a modal underneath (Settings)
  // that also listens on window does not close along with it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // Opens from inside other modals: above Settings (1100) and Onboarding (1150), below system alerts (1200).
        zIndex: 1160,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(1400px, 96vw)',
          height: 'min(96vh, 1000px)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-color)',
          borderRadius: 12,
          overflow: 'hidden',
          boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            borderBottom: '1px solid var(--border-color)',
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('tickets.close')}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: 16,
              padding: '2px 6px',
            }}
          >
            ×
          </button>
        </div>

        {children}

        {/* Footer: use the currently-browsed folder */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 16px',
            borderTop: '1px solid var(--border-color)',
            background: 'var(--bg-primary)',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              flex: 1,
              fontSize: 11,
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-secondary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              direction: 'rtl',
              textAlign: 'left',
            }}
          >
            <span dir="ltr">{currentPath}</span>
          </span>
          <button
            type="button"
            onClick={() => onPick(currentPath)}
            disabled={!currentPath}
            style={{
              fontSize: 13,
              fontWeight: 600,
              padding: '8px 16px',
              borderRadius: 8,
              border: 'none',
              background: currentPath ? 'var(--accent-blue)' : 'var(--bg-tertiary)',
              color: currentPath ? 'var(--on-accent)' : 'var(--text-secondary)',
              cursor: currentPath ? 'pointer' : 'not-allowed',
              whiteSpace: 'nowrap',
            }}
          >
            {t('tickets.useThisFolder')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
