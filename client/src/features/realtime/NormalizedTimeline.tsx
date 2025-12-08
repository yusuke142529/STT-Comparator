import { memo, useMemo } from 'react';
import type { NormalizedRow } from '../../types/app';

interface NormalizedTimelineProps {
  windows: NormalizedRow[][];
  providers: string[];
  chunkMs: number;
}

const formatTimeRange = (startMs: number, endMs: number) => {
  const toSec = (ms: number) => (ms / 1000).toFixed(2);
  return `${toSec(startMs)}s – ${toSec(endMs)}s`;
};

export const NormalizedTimeline = memo(({ windows, providers, chunkMs }: NormalizedTimelineProps) => {
  const providerOrder = useMemo(() => providers.filter(Boolean), [providers]);

  const rows = useMemo(() => {
    const keep = Math.max(10, Math.ceil(120000 / Math.max(1, chunkMs)));
    return windows.slice(-keep);
  }, [windows, chunkMs]);

  return (
    <div className="normalized-grid">
      {rows.length === 0 && <div className="normalized-empty">まだ正規化された結果がありません</div>}
      {rows.map((cells) => {
        if (cells.length === 0) return null;
        const { windowId, windowStartMs, windowEndMs } = cells[0];
        return (
          <section key={windowId} className="normalized-window">
            <header className="normalized-window__meta">
              <div className="normalized-window__time">{formatTimeRange(windowStartMs, windowEndMs)}</div>
              <div className="normalized-window__id">segment #{windowId}</div>
            </header>
            <div className="normalized-window__providers" style={{ gridTemplateColumns: `repeat(${Math.max(1, providerOrder.length)}, minmax(0, 1fr))` }}>
              {providerOrder.map((id) => {
                const cell = cells.find((c) => c.provider === id);
                if (!cell) {
                  return (
                    <div key={`${windowId}-${id}`} className="normalized-card normalized-card--empty">
                      <div className="normalized-card__provider">{id}</div>
                      <div className="normalized-card__text">—</div>
                    </div>
                  );
                }
                return (
                  <article
                    key={cell.normalizedId ?? `${windowId}-${id}-${cell.revision}`}
                    className={`normalized-card ${cell.isFinal ? 'final' : 'interim'}`}
                  >
                    <div className="normalized-card__provider">{id}</div>
                    <p className="normalized-card__text" title={cell.textRaw || cell.textNorm}>
                      {cell.textDelta || cell.textNorm || '—'}
                    </p>
                    <div className="normalized-card__meta">
                      {typeof cell.latencyMs === 'number' ? <span>{cell.latencyMs}ms</span> : <span>latency n/a</span>}
                      <span>rev {cell.revision}</span>
                      {cell.confidence != null && <span>conf {Math.round(cell.confidence * 100)}%</span>}
                      {cell.punctuationApplied === false && <span>punct off</span>}
                      {cell.casingApplied === false && <span>lowered</span>}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
});
