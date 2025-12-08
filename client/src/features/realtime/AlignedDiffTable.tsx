import { memo, useMemo } from 'react';
import type { NormalizedRow } from '../../types/app';

interface AlignedDiffTableProps {
  windows: NormalizedRow[][];
  providers: string[];
  chunkMs: number;
}

const formatTimeRange = (startMs: number, endMs: number) => {
  const toSec = (ms: number) => (ms / 1000).toFixed(2);
  return `${toSec(startMs)}s - ${toSec(endMs)}s`;
};

export const AlignedDiffTable = memo(({ windows, providers, chunkMs }: AlignedDiffTableProps) => {
  const providerOrder = useMemo(
    () => providers.filter(Boolean),
    [providers]
  );
  const columnTemplate = useMemo(
    () => `160px repeat(${Math.max(1, providerOrder.length)}, 1fr)`,
    [providerOrder.length]
  );

  const rows = useMemo(() => {
    const keep = Math.max(10, Math.ceil(60000 / Math.max(1, chunkMs)));
    return windows.slice(-keep);
  }, [windows, chunkMs]);

  const baseProvider = providerOrder[0];

  return (
    <div className="aligned-table">
      <div className="aligned-row head" style={{ gridTemplateColumns: columnTemplate }}>
        <div className="aligned-cell head time">Time</div>
        {providerOrder.map((id) => (
          <div key={id} className="aligned-cell head">
            {id}
          </div>
        ))}
      </div>
      {rows.map((cells) => {
        if (cells.length === 0) return null;
        const { windowId, windowStartMs, windowEndMs } = cells[0];
        const baseline = cells.find((c) => c.provider === baseProvider)?.textNorm ?? cells[0]?.textNorm ?? '';
        return (
          <div key={windowId} className="aligned-row" style={{ gridTemplateColumns: columnTemplate }}>
            <div className="aligned-cell time">
              <div className="aligned-time">{formatTimeRange(windowStartMs, windowEndMs)}</div>
              <div className="aligned-window">#{windowId}</div>
            </div>
            {providerOrder.map((id) => {
              const cell = cells.find((c) => c.provider === id);
              if (!cell) {
                return (
                  <div key={`${windowId}-${id}`} className="aligned-cell empty">
                    —
                  </div>
                );
              }
              const diff = baseline && cell.textNorm !== baseline;
              return (
                <div
                  key={`${windowId}-${id}`}
                  className={`aligned-cell ${cell.isFinal ? 'final' : 'interim'} ${diff ? 'diff' : ''}`}
                  title={cell.textRaw || cell.textNorm}
                >
                  <div className="aligned-text">{cell.textNorm || '—'}</div>
                  <div className="aligned-meta">
                    {typeof cell.latencyMs === 'number' ? `${cell.latencyMs}ms` : ''}
                    {cell.revision > 1 ? ` · rev${cell.revision}` : ''}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
});
