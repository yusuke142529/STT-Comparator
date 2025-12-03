import { memo, RefObject } from 'react';
import { Icons } from './icons';
import type { TranscriptRow } from '../types/app';

interface TranscriptViewerProps {
  transcripts: TranscriptRow[];
  containerRef: RefObject<HTMLDivElement>;
  showJumpButton: boolean;
  onJumpToBottom: () => void;
}

export const TranscriptViewer = memo(({ transcripts, containerRef, showJumpButton, onJumpToBottom }: TranscriptViewerProps) => (
  <section className="transcript-panel">
    <div className="transcript-header">
      <div>
        <p className="helper-text" style={{ marginBottom: 4 }}>Realtime</p>
        <h3>Live Transcript</h3>
      </div>
      {showJumpButton && (
        <button type="button" className="scroll-hint" onClick={onJumpToBottom}>
          ↓ 最新へ戻る
        </button>
      )}
    </div>
    <div className="transcript-body" ref={containerRef}>
      {transcripts.length === 0 ? (
        <div className="transcript-empty">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <Icons.Mic />
            <span>音声を待機中...</span>
          </div>
          <p className="helper-text">マイクまたは内部再生を開始するとトランスクリプトが記録されます。</p>
        </div>
      ) : (
        transcripts.map((row) => (
          <article key={row.id} className={`msg-bubble ${row.isFinal ? 'final' : 'interim'}`}>
            <div className="bubble-meta">
              <span>{new Date(row.timestamp).toLocaleTimeString([], { hour12: false, minute: '2-digit', second: '2-digit' })}</span>
              <span className="bubble-latency">{row.latencyMs ? `${row.latencyMs}ms` : ''}</span>
              {row.degraded && <span className="bubble-badge degraded">Degraded</span>}
            </div>
            <p className="bubble-text">{row.text}</p>
            <div className="msg-provider">
              {row.provider || 'Provider'}
            </div>
          </article>
        ))
      )}
    </div>
  </section>
));
