import { useTranslation } from 'react-i18next';
import type { AgentInfo, AgentStats as AgentStatsType } from '@open-alive/core';

interface AgentStatsProps {
  stats: AgentStatsType | null;
  agents: AgentInfo[];
}

export function AgentStats({ stats, agents }: AgentStatsProps) {
  const { t } = useTranslation();

  if (!stats || stats.totalAgents === 0) return null;

  const totalTokens = agents.reduce((sum, a) => sum + (a.tokenUsage?.totalTokens ?? 0), 0);

  const topTools = Object.entries(stats.toolCallsByName)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const subagentTypes = Object.entries(stats.subagentsByType)
    .sort((a, b) => b[1] - a[1]);

  return (
    <div
      className="border rounded-xl overflow-hidden"
      style={{ background: 'var(--bg-card)', borderColor: 'var(--border-color)' }}
    >
      <div
        className="px-4 py-3 text-[12px] font-semibold border-b flex items-center justify-between"
        style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}
      >
        <span>{t('stats.title')}</span>
        <div className="flex items-center gap-3 text-[10px]">
          <span>
            <span style={{ color: 'var(--accent-green)' }}>{stats.activeAgents}</span>
            {' '}{t('stats.active')}
          </span>
          <span>
            <span style={{ color: 'var(--text-primary)' }}>{stats.totalAgents}</span>
            {' '}{t('stats.total')}
          </span>
        </div>
      </div>

      <div className="px-4 py-3 space-y-2.5">
        {subagentTypes.length > 0 && (
          <div>
            <div className="text-[11px] font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
              {t('stats.subagentTypes')}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {subagentTypes.map(([type, count]) => (
                <span
                  key={type}
                  className="px-2.5 py-1 rounded-md text-[11px] font-medium"
                  style={{ background: 'var(--accent-purple)15', color: 'var(--accent-purple)' }}
                >
                  {type} ×{count}
                </span>
              ))}
            </div>
          </div>
        )}

        {topTools.length > 0 && (
          <div>
            <div className="text-[11px] font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
              {t('stats.topTools')}
            </div>
            <div className="space-y-1">
              {topTools.map(([tool, count]) => (
                <div key={tool} className="flex items-center justify-between text-[12px]">
                  <span style={{ color: 'var(--text-primary)' }}>{tool}</span>
                  <span style={{ color: 'var(--text-secondary)' }}>{count} {t('stats.calls')}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {totalTokens > 0 && (
          <div>
            <div className="text-[11px] font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
              {t('tokens.title')}
            </div>
            <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              {totalTokens.toLocaleString()} {t('tokens.total')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
