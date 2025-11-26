import type {
  RealtimeLogPayload,
  RealtimeLogPayloadType,
  TranscriptWord,
} from '../types/app';

export const LOG_TYPE_LABELS: Record<RealtimeLogPayloadType, string> = {
  session: 'セッション開始',
  transcript: '文字起こし',
  error: 'エラー',
  session_end: 'セッション終了',
};

export const LOG_TYPE_CLASSES: Record<RealtimeLogPayloadType, string> = {
  session: 'log-type--session',
  transcript: 'log-type--transcript',
  error: 'log-type--error',
  session_end: 'log-type--session_end',
};

const renderMetadataRows = (
  rows: Array<[string, string | null | undefined]>
): JSX.Element | null => {
  const filtered = rows.filter(([, value]) => value != null && value !== '');
  if (filtered.length === 0) return null;
  return (
    <div className="log-metadata">
      {filtered.map(([label, value]) => (
        <div key={label} className="log-metadata__item">
          <span className="log-metadata__label">{label}</span>
          <span>{value}</span>
        </div>
      ))}
    </div>
  );
};

const renderWordDetails = (words: TranscriptWord[]): JSX.Element => (
  <details className="log-words-detail">
    <summary>単語詳細 ({words.length})</summary>
    <div className="log-words-table-wrapper">
      <table className="log-words-table">
        <thead>
          <tr>
            <th>開始 (s)</th>
            <th>終了 (s)</th>
            <th>文字</th>
            <th>信頼度</th>
          </tr>
        </thead>
        <tbody>
          {words.map((word, index) => (
            <tr key={`${word.text}-${index}`}>
              <td>{word.startSec.toFixed(3)}</td>
              <td>{word.endSec.toFixed(3)}</td>
              <td>{word.text || '-'}</td>
              <td>
                {typeof word.confidence === 'number'
                  ? `${(word.confidence * 100).toFixed(1)}%`
                  : '-'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </details>
);

export const describeLogPayload = (payload: RealtimeLogPayload): string => {
  switch (payload.type) {
    case 'session':
      return `${payload.provider} ${payload.startedAt}`;
    case 'transcript': {
      const status = payload.isFinal ? '確定' : '途中';
      const channel = payload.channel === 'file' ? 'ファイル' : 'マイク';
      return `${channel} (${status}): ${payload.text}`;
    }
    case 'error':
      return payload.message;
    case 'session_end':
      return payload.reason ? `終了 (${payload.reason})` : '終了';
    default:
      return '';
  }
};

export const renderLogMetadata = (
  payload: RealtimeLogPayload,
  formatDate: (iso: string) => string
): JSX.Element | null => {
  switch (payload.type) {
    case 'session':
      return renderMetadataRows([
        ['セッションID', payload.sessionId],
        ['開始時刻', payload.startedAt ? formatDate(payload.startedAt) : null],
      ]);
    case 'transcript': {
      const metadata = renderMetadataRows([
        ['チャネル', payload.channel === 'file' ? 'ファイル' : 'マイク'],
        ['ステータス', payload.isFinal ? '確定' : '途中'],
        ['タイムスタンプ', typeof payload.timestamp === 'number' ? `${payload.timestamp} ms` : null],
        ['単語数', payload.words ? String(payload.words.length) : '0'],
      ]);
      if (!metadata && (!payload.words || payload.words.length === 0)) return null;
      return (
        <>
          {metadata}
          {payload.words && payload.words.length > 0 ? renderWordDetails(payload.words) : null}
        </>
      );
    }
    case 'error':
      return renderMetadataRows([['メッセージ', payload.message]]);
    case 'session_end':
      return renderMetadataRows([
        ['終了理由', payload.reason ?? '（未指定）'],
        ['終了時刻', formatDate(payload.endedAt)],
      ]);
    default:
      return null;
  }
};
