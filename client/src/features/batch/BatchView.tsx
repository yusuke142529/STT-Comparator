import { ChangeEvent, Dispatch, SetStateAction, useMemo, useState } from 'react';
import { Icons } from '../../components/icons';
import { fmt } from '../../utils/metrics';
import type { FileResult, JobStatus, PunctuationPolicy, ProviderInfo, SubmitBatchInput } from '../../types/app';

interface BatchViewProps {
  primaryProvider: string;
  setPrimaryProvider: (value: string) => void;
  secondaryProvider: string | null;
  setSecondaryProvider: (value: string | null) => void;
  compareMode: boolean;
  setCompareMode: (value: boolean) => void;
  providers: ProviderInfo[];
  dictionary: string;
  setDictionary: Dispatch<SetStateAction<string>>;
  dictionaryPhrases: string[];
  enableVad: boolean;
  punctuationPolicy: PunctuationPolicy;
  setPunctuationPolicy: (value: PunctuationPolicy) => void;
  parallel: number;
  setParallel: (value: number) => void;
  lang: string;
  submitBatch: (payload: SubmitBatchInput) => void;
  jobStatus: JobStatus | null;
  jobError: string | null;
  isBatchRunning: boolean;
  jobResults: FileResult[];
  lastJobId: string | null;
}

export const BatchView = ({
  primaryProvider,
  setPrimaryProvider,
  secondaryProvider,
  setSecondaryProvider,
  compareMode,
  setCompareMode,
  providers,
  dictionary,
  setDictionary,
  dictionaryPhrases,
  enableVad,
  punctuationPolicy,
  setPunctuationPolicy,
  parallel,
  setParallel,
  lang,
  submitBatch,
  jobStatus,
  jobError,
  isBatchRunning,
  jobResults,
  lastJobId,
}: BatchViewProps) => {
  const [files, setFiles] = useState<FileList | null>(null);
  const [manifestJson, setManifestJson] = useState('');

  const primary = useMemo(() => providers.find((item) => item.id === primaryProvider), [providers, primaryProvider]);
  const secondary = useMemo(
    () => (secondaryProvider ? providers.find((item) => item.id === secondaryProvider) : undefined),
    [providers, secondaryProvider]
  );
  const selectedProviderAvailable = primary?.available ?? true;
  const selectedProviderBatchReady = selectedProviderAvailable && (primary?.supportsBatch ?? true);
  const dictionarySupported = primary?.supportsDictionaryPhrases !== false;
  const secondaryProviderReady = compareMode
    ? Boolean(secondary?.available && (secondary?.supportsBatch ?? true) && secondaryProvider !== primaryProvider)
    : true;

  const progress = useMemo(() => {
    if (!jobStatus || jobStatus.total === 0) return 0;
    return Math.round(((jobStatus.done + jobStatus.failed) / jobStatus.total) * 100);
  }, [jobStatus]);

  const handleFilesChange = (event: ChangeEvent<HTMLInputElement>) => {
    setFiles(event.target.files);
  };

  const handleSubmit = () => {
    const chosenProviders = compareMode && secondaryProvider
      ? [primaryProvider, secondaryProvider].filter((v, idx, arr) => arr.indexOf(v) === idx)
      : [primaryProvider];
    if (compareMode && chosenProviders.length < 2) {
      alert('比較する2つのプロバイダーを選択してください');
      return;
    }
    submitBatch({
      files,
      manifestJson,
      providers: chosenProviders,
      lang,
      dictionaryPhrases,
      enableVad,
      punctuationPolicy,
      parallel,
    });
  };

  const transcriptEntries = useMemo(() => jobResults, [jobResults]);
  const displayJobId = lastJobId ?? jobStatus?.jobId;
  const transcriptHeading = displayJobId
    ? `Job ${displayJobId.slice(0, 8)} の文字起こし`
    : '最新の文字起こし結果';

  return (
    <section className="card">
      <h2><Icons.Upload /> バッチ処理 (Batch Processing)</h2>
      <div className="controls-grid">
        <div className="control-group" style={{ gridColumn: 'span 2' }}>
          <label>音声ファイル (Audio Files)</label>
          <div className="file-input-wrapper" onClick={() => document.getElementById('file-upload')?.click()}>
            <div style={{ color: 'var(--primary)', marginBottom: 8 }}><Icons.Upload /></div>
            <div style={{ color: files && files.length > 0 ? 'var(--text-main)' : 'var(--text-sub)', fontWeight: 500 }}>
              {files && files.length > 0 ? `${files.length} ファイルを選択中` : 'クリックして音声ファイルを選択'}
            </div>
            <input id="file-upload" type="file" multiple onChange={handleFilesChange} style={{ display: 'none' }} />
          </div>
        </div>
        <div className="control-group">
          <label>プロバイダー</label>
          <select value={primaryProvider} onChange={(event) => setPrimaryProvider(event.target.value)}>
            {providers.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.available}>{p.id}</option>
            ))}
          </select>
        </div>
        <div className="control-group">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={compareMode}
              onChange={(event) => setCompareMode(event.target.checked)}
            />
            2プロバイダーで比較
          </label>
          <select
            value={secondaryProvider ?? ''}
            onChange={(event) => setSecondaryProvider(event.target.value || null)}
            disabled={!compareMode}
          >
            <option value="">選択してください</option>
            {providers
              .filter((p) => p.id !== primaryProvider)
              .map((p) => (
                <option key={p.id} value={p.id} disabled={!p.available || !p.supportsBatch}>
                  {p.id}
                </option>
              ))}
          </select>
        </div>
        <div className="control-group">
          <label>句読点</label>
          <select value={punctuationPolicy} onChange={(event) => setPunctuationPolicy(event.target.value as PunctuationPolicy)}>
            { (primaryProvider === 'deepgram' ? ['none', 'full'] : ['none', 'basic', 'full'] as PunctuationPolicy[]).map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        </div>
        <div className="control-group">
          <label>並列数</label>
          <input type="number" min={1} max={8} value={parallel} onChange={(event) => setParallel(Number(event.target.value) || 1)} />
          <div className="muted" style={{ fontSize: '0.75rem' }}>
            ファイルの同時処理数。複数プロバイダー比較時はサーバ側でプロバイダー数まで自動的に切り上げ、同じ音源を同時並行で転写します。
          </div>
        </div>
        <div className="control-group">
          <button
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={
              !selectedProviderAvailable ||
              !selectedProviderBatchReady ||
              !secondaryProviderReady ||
              isBatchRunning
            }
            style={{ height: '44px' }}
          >
            {isBatchRunning ? '処理中...' : (<><Icons.Play /> ジョブ実行</>)}
          </button>
        </div>
      </div>

      <div className="controls-grid" style={{ marginTop: '1.5rem' }}>
        <div className="control-group" style={{ gridColumn: 'span 2' }}>
          <label>リファレンスJSON (正解データ)</label>
          <textarea
            value={manifestJson}
            onChange={(event) => setManifestJson(event.target.value)}
            rows={3}
            placeholder='例: {"version":1,"language":"ja-JP","items":[{"audio":"file1.wav","ref":"こんにちは"}]}'
          />
          <div className="muted" style={{ fontSize: '0.75rem' }}>
            CER/WERを計算するには manifest.json が必要です。形式は sample-data/manifest.example.json を参照してください。
          </div>
        </div>
        <div className="control-group">
          <label>辞書 / キーワード</label>
            <textarea
              value={dictionary}
              onChange={(event) => setDictionary(event.target.value)}
              disabled={!dictionarySupported}
              rows={3}
              placeholder="キーワードを改行区切りで入力..."
            />
            <div className="muted" style={{ fontSize: '0.75rem' }}>
              {dictionarySupported
                ? '辞書はRealtimeにも影響します。'
                : 'このプロバイダは辞書設定を使用しません。'}
            </div>
          </div>
      </div>

      {jobStatus && (
        <div style={{ marginTop: '2rem', padding: '1rem', background: 'var(--bg-subtle)', borderRadius: 'var(--radius)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem', marginBottom: 6, fontWeight: 600 }}>
            <span>処理状況 (Job ID: {jobStatus.jobId})</span>
            <span>{progress}%</span>
          </div>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: `${((jobStatus.done + jobStatus.failed) / Math.max(jobStatus.total, 1)) * 100}%` }}
            />
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 12, fontSize: '0.8rem', color: 'var(--text-sub)' }}>
            <span>Total: <b>{jobStatus.total}</b></span>
            <span style={{ color: 'var(--success)' }}>成功: <b>{jobStatus.done}</b></span>
            <span style={{ color: 'var(--error)' }}>失敗: <b>{jobStatus.failed}</b></span>
          </div>
        </div>
      )}

      {jobError && (
        <div className="banner error" style={{ marginTop: '1rem' }}>
          <div>{jobError}</div>
          <button className="btn btn-ghost" onClick={handleSubmit} disabled={isBatchRunning}>リトライ</button>
        </div>
      )}

      {transcriptEntries.length > 0 && (
        <section className="card transcript-card" style={{ marginTop: '2rem' }}>
          <div className="transcript-card__header">
            <div>
              <h3>{transcriptHeading}</h3>
              <p className="muted" style={{ margin: 0, fontSize: '0.85rem' }}>
                JSON/CSV出力せずにジョブ内の文字起こしを直接確認できます。
              </p>
            </div>
          </div>

          <div className="transcript-list">
            {transcriptEntries.map((entry, index) => {
              const text = entry.text?.trim() ? entry.text : '（文字起こしデータなし）';
              return (
                <details
                  key={`${entry.provider}-${entry.path}-${index}`}
                  className="transcript-entry"
                  open={index === 0}
                >
                  <summary>
                    <div className="transcript-entry__meta">
                      <span className="transcript-entry__path">{entry.path}</span>
                      <span className="msg-provider">{entry.provider}</span>
                      {entry.degraded && <span className="bubble-badge degraded" aria-label="degraded decode">degraded</span>}
                    </div>
                    <div className="transcript-entry__metrics">
                      {entry.cer != null && <span>CER: {fmt(entry.cer)}</span>}
                      {entry.wer != null && <span>WER: {fmt(entry.wer)}</span>}
                      {entry.rtf != null && <span>RTF: {fmt(entry.rtf)}</span>}
                    </div>
                  </summary>
                  <div className="transcript-entry__text" aria-live="polite">
                    {text}
                  </div>
                </details>
              );
            })}
          </div>
        </section>
      )}
    </section>
  );
};
