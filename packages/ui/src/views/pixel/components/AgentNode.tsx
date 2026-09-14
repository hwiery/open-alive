import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentInfo } from '@open-alive/core';
import type { Character } from '../engine/character';
import { getSpriteDataUrl } from '../utils/spriteToImage';

interface AgentNodeProps {
  agent: AgentInfo;
  character: Character | undefined;
  onClick: (sessionId: string) => void;
}

const STATE_BORDERS: Record<string, string> = {
  active: 'var(--accent-blue)',
  idle: 'var(--border-color)',
  listening: 'var(--border-color)',
  spawning: 'var(--border-color)',
  waiting: 'var(--accent-amber)',
  error: 'var(--accent-red)',
  done: 'var(--accent-green)',
  despawning: 'var(--border-color)',
  removed: 'var(--border-color)',
};

export function AgentNode({ agent, character, onClick }: AgentNodeProps) {
  const { t } = useTranslation();
  const borderColor = STATE_BORDERS[agent.state] ?? '#333348';
  const name = agent.displayName || t('agents.generalAgent');
  const label = (agent.state === 'active' && agent.currentTool) ? agent.currentTool : t(`pixelStates.${agent.state}`, { defaultValue: agent.state });

  const spriteUrl = useMemo(() => {
    if (!character) return null;
    return getSpriteDataUrl(character.paletteIndex, character.sprites.idle.down);
  }, [character?.paletteIndex]);

  return (
    <div
      onClick={() => onClick(agent.sessionId)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
        background: 'rgba(22, 27, 34, 0.9)',
        border: `2px solid ${borderColor}`,
        borderRadius: 12,
        cursor: 'pointer',
        minWidth: 140,
        transition: 'all 0.2s ease',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(33, 38, 45, 0.95)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'rgba(22, 27, 34, 0.9)'; e.currentTarget.style.transform = 'translateY(0)'; }}
    >
      {spriteUrl && (
        <img
          src={spriteUrl}
          alt=""
          style={{ width: 18, height: 36, imageRendering: 'pixelated' }}
        />
      )}
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--text-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: 100,
        }}>
          {name}
        </div>
        <div style={{
          fontSize: 11,
          color: borderColor,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: 100,
          marginTop: 2,
        }}>
          {label}
        </div>
      </div>
    </div>
  );
}
