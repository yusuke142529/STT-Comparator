import type { JobSummary, RealtimeLatencySummary, SummaryStats } from '../types/app';
import { fmt } from '../utils/metrics';

export function StatCard({ title, value, unit }: { title: string; value: string; unit?: string }) {
  return (
    <div className="stat-card">
      <p className="stat-card__value">
        {value}
        {unit ? <small>{unit}</small> : null}
      </p>
      <p className="stat-card__label">{title}</p>
    </div>
  );
}

export type QuantileChartProps = {
  title: string;
  unit?: string;
  summaries: { provider: string; summary: JobSummary }[];
  selector: (summary: JobSummary) => SummaryStats;
};

export function QuantileChart({ title, unit = '', summaries, selector }: QuantileChartProps) {
  const max = Math.max(...summaries.map(({ summary }) => selector(summary).p95 ?? 0), 0);
  const safeMax = max > 0 ? max : 1;

  return (
    <div className="quantile-card">
      <div className="quantile-card__header">
        <h4>{title}</h4>
        <div className="quantile-card__legend">
          <span className="legend-p50">p50 (中央値)</span>
          <span className="legend-p95">p95</span>
        </div>
      </div>
      <div className="quantile-bars">
        {summaries.map(({ provider, summary }) => {
          const stats = selector(summary);
          const widthP50 = stats.p50 == null ? 0 : Math.min((stats.p50 / safeMax) * 100, 100);
          const widthP95 = stats.p95 == null ? 0 : Math.min((stats.p95 / safeMax) * 100, 100);
          return (
            <div className="quantile-row" key={provider}>
              <div className="quantile-row__label" title={provider}>{provider}</div>
              <div className="quantile-row__bars">
                <div className="bar bar-p95" style={{ width: `${widthP95}%` }} title={`p95: ${fmt(stats.p95)}`} />
                <div className="bar bar-p50" style={{ width: `${widthP50}%` }} title={`p50: ${fmt(stats.p50)}`} />
              </div>
              <div className="quantile-row__values">
                {fmt(stats.p50)} / {fmt(stats.p95)} {unit}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function LatencyHistoryChart({ history, formatDate }: { history: RealtimeLatencySummary[]; formatDate: (iso: string) => string }) {
  if (history.length === 0) return null;
  const data = history;
  const maxVal = Math.max(...data.flatMap((h) => [h.p95 ?? 0, h.p50 ?? 0]), 0);
  const safeMax = maxVal > 0 ? maxVal * 1.1 : 100;
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  const getCoords = (key: keyof RealtimeLatencySummary) =>
    data.map((h, i) => {
      const x = data.length === 1 ? 50 : (i / (data.length - 1)) * 100;
      const val = (h[key] as number | null) ?? 0;
      const y = 100 - (val / safeMax) * 100;
      return [x, y] as [number, number];
    });

  const pointsP95 = getCoords('p95');
  const pointsP50 = getCoords('p50');

  const toPathStr = (pts: [number, number][]) => pts.map((p) => `${p[0]},${p[1]}`).join(' ');
  const toAreaStr = (pts: [number, number][]) => `${pts[0][0]},100 ${pts.map((p) => `${p[0]},${p[1]}`).join(' ')} ${pts[pts.length - 1][0]},100`;

  return (
    <div className="latency-chart">
      <div className="latency-chart__legend">
        <span><span className="dot dot-p50" /> p50 (中央値)</span>
        <span><span className="dot dot-p95" /> p95</span>
        <span className="muted latency-legend-spacer">Max: {Math.round(safeMax)} ms</span>
      </div>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <linearGradient id="gradP95" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#bfdbfe" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#bfdbfe" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="gradP50" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.2" />
            <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g className="latency-chart__grid">
          {ticks.map((tick) => {
            const y = 100 - tick * 100;
            return <line key={tick} x1="0" x2="100" y1={y} y2={y} strokeDasharray="2 2" />;
          })}
        </g>
        <polygon points={toAreaStr(pointsP95)} fill="url(#gradP95)" />
        <polygon points={toAreaStr(pointsP50)} fill="url(#gradP50)" />
        <polyline className="latency-line p95" points={toPathStr(pointsP95)} fill="none" />
        <polyline className="latency-line p50" points={toPathStr(pointsP50)} fill="none" />
        {data.map((entry, idx) => {
          const x = data.length === 1 ? 50 : (idx / (data.length - 1)) * 100;
          const y50 = 100 - ((entry.p50 ?? 0) / safeMax) * 100;
          const y95 = 100 - ((entry.p95 ?? 0) / safeMax) * 100;
          const label = `${formatDate(entry.startedAt)}\np50: ${fmt(entry.p50)} ms\np95: ${fmt(entry.p95)} ms`;
          return (
            <g key={entry.sessionId}>
              <circle className="latency-dot p95" cx={x} cy={y95} r={1.8}>
                <title>{label}</title>
              </circle>
              <circle className="latency-dot p50" cx={x} cy={y50} r={1.8}>
                <title>{label}</title>
              </circle>
            </g>
          );
        })}
        <g className="latency-chart__ticks">
          {ticks.slice(1).map((tick) => {
            const y = 100 - tick * 100;
            return <text key={tick} x="0" y={y + 3}>{Math.round(safeMax * tick)}</text>;
          })}
        </g>
      </svg>
      <div className="latency-chart__scale">
        <span>{formatDate(data[0].startedAt)}</span>
        <span>最新 → {formatDate(data[data.length - 1].startedAt)}</span>
      </div>
    </div>
  );
}
