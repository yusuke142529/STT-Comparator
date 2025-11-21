import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRetry } from './useRetry';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4100';

// --- SVG Icons (Lucide-style wrappers) ---
const Icons = {
  Mic: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>,
  Stop: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>,
  Play: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>,
  Upload: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>,
  Refresh: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>,
  Alert: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>,
  Check: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>,
  Download: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
};

// --- Types ---
interface TranscriptRow {
  text: string;
  provider: string;
  isFinal: boolean;
  timestamp: number;
  latencyMs?: number;
}

interface JobStatus {
  jobId: string;
  total: number;
  done: number;
  failed: number;
}

interface SummaryStats {
  avg: number | null;
  p50: number | null;
  p95: number | null;
}

interface JobSummary {
  count: number;
  cer: SummaryStats;
  wer: SummaryStats;
  rtf: SummaryStats;
  latencyMs: SummaryStats;
}

interface ProviderInfo {
  id: string;
  available: boolean;
  reason?: string;
  implemented?: boolean;
}

interface FileResult {
  path: string;
  provider: string;
  cer?: number | null;
  wer?: number | null;
  rtf?: number | null;
  latencyMs?: number | null;
  text?: string;
}

interface RealtimeLatencySummary {
  sessionId: string;
  provider: string;
  lang: string;
  count: number;
  avg: number | null;
  p50: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
  startedAt: string;
  endedAt: string;
}

interface WsPayload {
  type: 'session' | 'transcript' | 'error';
  sessionId?: string;
  latencyMs?: number;
  message?: string;
  text?: string;
  provider?: string;
  isFinal?: boolean;
  timestamp?: number;
}

// --- Helpers ---
const fmt = (v: number | null | undefined) => (v == null ? '-' : v.toFixed(3));

const summarizeMetric = (values: Array<number | null | undefined>): SummaryStats => {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) return { avg: null, p50: null, p95: null };
  const sorted = [...nums].sort((a, b) => a - b);
  const quantile = (q: number) => {
    const pos = (sorted.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (sorted[base + 1] !== undefined) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
    return sorted[base];
  };
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
  return { avg, p50: quantile(0.5), p95: quantile(0.95) };
};

const summarizeJobLocal = (rows: FileResult[]): JobSummary => ({
  count: rows.length,
  cer: summarizeMetric(rows.map((r) => r.cer)),
  wer: summarizeMetric(rows.map((r) => r.wer)),
  rtf: summarizeMetric(rows.map((r) => r.rtf)),
  latencyMs: summarizeMetric(rows.map((r) => r.latencyMs)),
});

const parseDictionary = (text: string): string[] => {
  return text.split('\n').map((s) => s.trim()).filter(Boolean);
};

const fetchJson = async <T,>(url: string): Promise<T> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url}`);
  return (await res.json()) as T;
};

// --- Main Component ---

export default function App() {
  // Settings
  const [provider, setProvider] = useState('mock');
  const [lang, setLang] = useState('ja-JP');
  const [enableInterim, setEnableInterim] = useState(true);
  const [enableVad, setEnableVad] = useState(false);
  const [punctuationPolicy, setPunctuationPolicy] = useState<'none' | 'basic' | 'full'>('full');
  const [dictionary, setDictionary] = useState('');
  const [parallel, setParallel] = useState(1);
  const [chunkMs, setChunkMs] = useState(250);

  // Data / Status
  const [providers, setProviders] = useState<ProviderInfo[]>([
    { id: 'mock', available: true, implemented: true },
    { id: 'deepgram', available: true, implemented: true },
  ]);
  const [providerWarning, setProviderWarning] = useState<string | null>(null);
  const [tab, setTab] = useState<'realtime' | 'batch' | 'results'>('realtime');
  const [lastJobId, setLastJobId] = useState<string | null>(null);

  // Realtime States
  const [transcripts, setTranscripts] = useState<TranscriptRow[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [realtimeError, setRealtimeError] = useState<string | null>(null);
  const [latencies, setLatencies] = useState<number[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [latencyHistory, setLatencyHistory] = useState<RealtimeLatencySummary[]>([]);
  const [timezone, setTimezone] = useState<'local' | 'utc'>('local');
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  // Batch States
  const [files, setFiles] = useState<FileList | null>(null);
  const [manifestJson, setManifestJson] = useState('');
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [jobResults, setJobResults] = useState<FileResult[]>([]);
  const [jobError, setJobError] = useState<string | null>(null);
  const [jobSummary, setJobSummary] = useState<JobSummary | null>(null);
  const [isBatchRunning, setIsBatchRunning] = useState(false);

  // Results Filter States
  const [resultsProviderFilter, setResultsProviderFilter] = useState<string>('all');
  const [pathQuery, setPathQuery] = useState('');

  // Refs
  const recorderRef = useRef<MediaRecorder | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const streamingRef = useRef(false);
  const pollIntervalRef = useRef<number | null>(null);

  // Retries
  const realtimeRetry = useRetry({ maxAttempts: 3, baseDelayMs: 1000 });
  const batchRetry = useRetry({ maxAttempts: 2, baseDelayMs: 1000 });

  const wsUrl = useMemo(() => {
    const base = API_BASE.replace('http', 'ws');
    return `${base.replace(/\/$/, '')}/ws/stream?provider=${provider}&lang=${lang}`;
  }, [provider, lang]);

  const punctuationOptions = useMemo<('none' | 'basic' | 'full')[]>(
    () => (provider === 'deepgram' ? ['none', 'full'] : ['none', 'basic', 'full']),
    [provider]
  );

  useEffect(() => {
    if (!punctuationOptions.includes(punctuationPolicy)) {
      setPunctuationPolicy(punctuationOptions[punctuationOptions.length - 1]);
    }
  }, [punctuationOptions, punctuationPolicy]);

  // Initial Load
  useEffect(() => {
    const loadProviders = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/providers`);
        if (!res.ok) throw new Error('プロバイダ情報の取得に失敗しました');
        const json = (await res.json()) as ProviderInfo[];
        setProviders(json);
        const firstAvailable = json.find((p) => p.available)?.id;
        if (firstAvailable && !json.find((p) => p.id === provider && p.available)) {
          setProvider(firstAvailable);
        }
        const unavailableReasons = json.filter((p) => !p.available && p.reason).map((p) => `${p.id}: ${p.reason}`);
        setProviderWarning(unavailableReasons[0] ?? null);
      } catch (error) {
        console.error(error);
        setProviderWarning((error as Error).message);
      }
    };
    loadProviders();
    const loadConfig = async () => {
      try {
        const cfg = await fetchJson<{ audio?: { chunkMs?: number } }>(`${API_BASE}/api/config`);
        if (cfg.audio?.chunkMs && Number.isFinite(cfg.audio.chunkMs)) {
          setChunkMs(cfg.audio.chunkMs);
        }
      } catch (err) {
        console.warn('config fetch failed', err);
      }
    };
    loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll for Realtime
  useEffect(() => {
    if (tab === 'realtime' && transcripts.length > 0) {
      transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcripts, tab]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      recorderRef.current?.stop();
      wsRef.current?.close();
      streamingRef.current = false;
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  const resultProviderOptions = useMemo(
    () => Array.from(new Set(jobResults.map((r) => r.provider))),
    [jobResults]
  );

  const selectedProviderAvailable = useMemo(
    () => providers.find((p) => p.id === provider)?.available ?? true,
    [provider, providers]
  );

  useEffect(() => {
    if (resultsProviderFilter !== 'all' && !resultProviderOptions.includes(resultsProviderFilter)) {
      setResultsProviderFilter('all');
    }
  }, [resultProviderOptions, resultsProviderFilter]);

  const filteredResults = useMemo(() => {
    const byProvider = resultsProviderFilter === 'all'
      ? jobResults
      : jobResults.filter((r) => r.provider === resultsProviderFilter);
    if (!pathQuery.trim()) return byProvider;
    const keyword = pathQuery.trim().toLowerCase();
    return byProvider.filter((r) => r.path.toLowerCase().includes(keyword));
  }, [jobResults, pathQuery, resultsProviderFilter]);

  const filteredSummary = useMemo(() => summarizeJobLocal(filteredResults), [filteredResults]);

  const providerSummaries = useMemo(
    () =>
      resultProviderOptions.map((id) => ({
        provider: id,
        summary: summarizeJobLocal(jobResults.filter((r) => r.provider === id)),
      })),
    [jobResults, resultProviderOptions]
  );

  const realtimeSummary = useMemo(() => summarizeMetric(latencies), [latencies]);

  const latencyHistoryChrono = useMemo(() => [...latencyHistory].reverse(), [latencyHistory]);

  const formatDate = useCallback((iso: string) => {
    const date = new Date(iso);
    if (timezone === 'utc') {
      return date.toLocaleString(undefined, { timeZone: 'UTC', hour12: false });
    }
    return date.toLocaleString();
  }, [timezone]);

  // --- Handlers ---
  const refreshLatencyHistory = useCallback(
    () => fetchJson<RealtimeLatencySummary[]>(`${API_BASE}/api/realtime/latency?limit=20`).then(setLatencyHistory),
    []
  );

  const downloadLatencyCsv = useCallback(() => {
    if (latencyHistory.length === 0) return;
    const fields: Array<keyof RealtimeLatencySummary> = ['sessionId', 'provider', 'lang', 'count', 'avg', 'p50', 'p95', 'min', 'max', 'startedAt', 'endedAt'];
    const escapeCsv = (value: unknown) => {
      if (value == null) return '';
      if (typeof value === 'string') return `"${value.replace(/"/g, '""')}"`;
      return String(value);
    };
    const rows = latencyHistory.map((item) => fields.map((field) => escapeCsv(item[field])).join(','));
    const csv = [fields.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'realtime-latency.csv';
    a.click();
    URL.revokeObjectURL(url);
  }, [latencyHistory]);

  const exportResults = useCallback(
    (format: 'csv' | 'json') => {
      if (!lastJobId) return;
      const suffix = format === 'csv' ? '?format=csv' : '?format=json';
      const url = `${API_BASE}/api/jobs/${lastJobId}/results${suffix}`;
      window.open(url, '_blank');
    },
    [lastJobId]
  );

  // History Fetch
  useEffect(() => {
    if (tab !== 'results') return;
    refreshLatencyHistory().catch((err) => console.warn('latency history fetch failed', err));
  }, [tab, refreshLatencyHistory]);

  const startRealtime = async () => {
    if (!selectedProviderAvailable) {
      setRealtimeError('選択したプロバイダは利用できません');
      return;
    }
    setRealtimeError(null);
    setLatencies([]);
    setSessionId(null);
    realtimeRetry.reset();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm; codecs=opus',
        audioBitsPerSecond: 64_000,
      });

      const socket = new WebSocket(wsUrl);
      wsRef.current = socket;
      recorderRef.current = mediaRecorder;

      const dictionaryPhrases = parseDictionary(dictionary);

      socket.addEventListener('open', () => {
        socket.send(
          JSON.stringify({
            type: 'config',
            enableInterim,
            contextPhrases: dictionaryPhrases,
            options: { enableVad, punctuationPolicy, dictionaryPhrases, parallel },
          })
        );
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          mediaRecorder.start(chunkMs);
        }
      });

      socket.addEventListener('message', (event) => {
        try {
          const payload = JSON.parse(event.data) as WsPayload;

          if (payload.type === 'session' && payload.sessionId) {
            setSessionId(payload.sessionId);
            realtimeRetry.reset();
          } else if (payload.type === 'transcript' && payload.text && typeof payload.timestamp === 'number') {
            setTranscripts((prev) => [
              ...prev.slice(-99),
              {
                text: payload.text!,
                provider: payload.provider || provider,
                isFinal: !!payload.isFinal,
                timestamp: payload.timestamp!,
                latencyMs: payload.latencyMs
              }
            ]);

            if (typeof payload.latencyMs === 'number') {
              setLatencies((prev) => {
                const next = [payload.latencyMs!, ...prev];
                return next.slice(0, 500);
              });
            }
          } else if (payload.type === 'error' && payload.message) {
            setRealtimeError(payload.message);
            socket.close();
          }
        } catch (e) {
          console.error('WebSocket message parse error', e);
        }
      });

      socket.addEventListener('error', () => {
        setRealtimeError('ストリーム接続でエラーが発生しました');
        streamingRef.current = false;
        setIsStreaming(false);
        realtimeRetry.schedule(startRealtime);
      });

      socket.addEventListener('close', () => {
        const wasStreaming = streamingRef.current;
        if (wasStreaming) setRealtimeError('ストリームが切断されました');
        recorderRef.current?.stop();
        stream.getTracks().forEach((track) => track.stop());
        streamingRef.current = false;
        setIsStreaming(false);
        if (wasStreaming) realtimeRetry.schedule(startRealtime);
        if (tab === 'realtime') {
          refreshLatencyHistory().catch(() => undefined);
        }
      });

      mediaRecorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(event.data);
        }
      });

      setTranscripts([]);
      streamingRef.current = true;
      setIsStreaming(true);

    } catch (error) {
      console.error(error);
      setRealtimeError('マイクにアクセスできませんでした');
    }
  };

  const stopRealtime = () => {
    streamingRef.current = false;
    setIsStreaming(false);
    recorderRef.current?.stop();
    wsRef.current?.close();
    setSessionId(null);
    realtimeRetry.reset();
  };

  const submitBatch = async () => {
    if (!selectedProviderAvailable) {
      setJobError('選択したプロバイダは利用できません');
      return;
    }
    if (isBatchRunning) return;

    batchRetry.reset();
    if (!files || files.length === 0) {
      alert('ファイルを選択してください');
      return;
    }

    let manifestPayload: string | null = null;
    if (manifestJson.trim()) {
      try {
        const parsed = JSON.parse(manifestJson);
        if (typeof parsed.version !== 'number' || parsed.version < 1) {
          throw new Error('version is required (number >= 1)');
        }
        if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
          throw new Error('items array is required');
        }
        parsed.items.forEach((item: any, idx: number) => {
          if (!item?.audio || !item?.ref) {
            throw new Error(`items[${idx}] must include audio and ref`);
          }
        });
        manifestPayload = JSON.stringify(parsed);
      } catch (error) {
        setJobError(`Manifestが不正です: ${(error as Error).message}`);
        return;
      }
    }

    setIsBatchRunning(true);
    setJobResults([]);
    setJobSummary(null);

    const form = new FormData();
    for (const file of Array.from(files)) form.append('files', file, file.name);
    form.append('provider', provider);
    form.append('lang', lang);
    if (manifestPayload) form.append('ref_json', manifestPayload);

    const dictionaryPhrases = parseDictionary(dictionary);
    form.append('options', JSON.stringify({ enableVad, punctuationPolicy, dictionaryPhrases, parallel }));

    try {
      const res = await fetch(`${API_BASE}/api/jobs/transcribe`, { method: 'POST', body: form });
      if (!res.ok) {
        const errText = await res.text();
        try {
          const parsed = JSON.parse(errText);
          throw new Error(parsed.message ?? 'ジョブ投入に失敗しました');
        } catch {
          throw new Error('ジョブ投入に失敗しました');
        }
      }
      const data = await res.json();
      pollStatus(data.jobId);
    } catch (error) {
      const message = (error as Error).message;
      setJobError(message);
      setIsBatchRunning(false);
      if (error instanceof TypeError || message.toLowerCase().includes('network')) {
        batchRetry.schedule(submitBatch);
      } else {
        batchRetry.reset();
      }
    }
  };

  const pollStatus = async (jobId: string) => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);

    setJobError(null);
    setJobStatus({ jobId, total: 0, done: 0, failed: 0 });

    pollIntervalRef.current = window.setInterval(async () => {
      try {
        const statusRes = await fetch(`${API_BASE}/api/jobs/${jobId}/status`);
        if (!statusRes.ok) throw new Error('ステータス取得失敗');
        const status = (await statusRes.json()) as JobStatus;
        setJobStatus(status);

        if (status.done + status.failed >= status.total) {
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          const resultRes = await fetch(`${API_BASE}/api/jobs/${jobId}/results`);
          const resultJson = (await resultRes.json()) as FileResult[];
          setJobResults(resultJson);
          setLastJobId(jobId);

          const summaryRes = await fetch(`${API_BASE}/api/jobs/${jobId}/summary`);
          if (summaryRes.ok) setJobSummary((await summaryRes.json()) as JobSummary);

          setIsBatchRunning(false);
        }
      } catch (err) {
        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
        setJobError('ステータス取得に失敗しました');
        setIsBatchRunning(false);
      }
    }, 1500);
  };

  // --- Render ---

  return (
    <main className="app-container">
      <header>
        <div>
          <h1>STT Comparator</h1>
          <p className="subtitle">Voice Recognition Evaluation Tool v1.0</p>
        </div>
        <nav className="tabs">
          <button className={tab === 'realtime' ? 'active' : ''} onClick={() => setTab('realtime')}>リアルタイム</button>
          <button className={tab === 'batch' ? 'active' : ''} onClick={() => setTab('batch')}>バッチ処理</button>
          <button className={tab === 'results' ? 'active' : ''} onClick={() => setTab('results')}>結果分析</button>
        </nav>
      </header>

      {/* Shared Error/Warning Banners */}
      {providerWarning && (
        <div className="banner warning">
          <Icons.Alert />
          <div>{providerWarning}</div>
        </div>
      )}

      {tab === 'realtime' && (
        <div className="realtime-view">
          <section className="card">
            <div className="controls-grid">
              <div className="control-group">
                <label>プロバイダー</label>
                <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.available}>
                      {p.id}{!p.available ? ' (利用不可)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="control-group">
                <label>言語 (Language)</label>
                <input value={lang} onChange={(e) => setLang(e.target.value)} />
              </div>
              <div className="control-group">
                <label>句読点の付与</label>
                <select value={punctuationPolicy} onChange={(e) => setPunctuationPolicy(e.target.value as 'none' | 'basic' | 'full')}>
                  {punctuationOptions.map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
                {provider === 'deepgram' && (
                  <div className="muted" style={{ fontSize: '0.75rem', marginTop: 4 }}>※Deepgramは句読点のon/offのみ対応</div>
                )}
              </div>
              <div className="control-group" style={{ justifyContent: 'center', paddingBottom: 4 }}>
                <div className="checkbox-group">
                  <label><input type="checkbox" checked={enableInterim} onChange={(e) => setEnableInterim(e.target.checked)} /> 途中経過を出力</label>
                  <label><input type="checkbox" checked={enableVad} onChange={(e) => setEnableVad(e.target.checked)} /> 音声区間検出(VAD)</label>
                </div>
              </div>
              <div className="control-group">
                <button
                  className={isStreaming ? "btn btn-danger" : "btn btn-primary"}
                  onClick={isStreaming ? stopRealtime : startRealtime}
                  disabled={!selectedProviderAvailable}
                  style={{ width: '100%' }}
                >
                  {isStreaming ? <><Icons.Stop /> 録音停止</> : <><Icons.Mic /> 録音開始</>}
                </button>
              </div>
            </div>

            {realtimeRetry.active && realtimeRetry.nextInMs !== null && (
               <div style={{ marginTop: '1rem', fontSize: '0.9rem', color: 'var(--warning)', fontWeight: 600 }}>
                 再接続まで {Math.max(realtimeRetry.nextInMs / 1000, 0).toFixed(1)}秒...
               </div>
            )}
              {realtimeError && (
                <div className="banner error" style={{ marginTop: '1rem' }}>
                   <Icons.Alert />
                   <div style={{ flex: 1 }}>
                     <div style={{ fontWeight: 'bold' }}>エラーが発生しました</div>
                     <div style={{ fontSize: '0.85rem' }}>{realtimeError}</div>
                     <div className="muted" style={{ marginTop: 4 }}>ブラウザのマイク権限を確認してください。Deepgram使用時は.envのAPIキーも確認してください。</div>
                   </div>
                </div>
              )}
          </section>

          <div style={{ display: 'grid', gridTemplateColumns: '3fr 1fr', gap: '1.5rem' }}>
            {/* Transcript Log */}
            <section className="transcript-window">
               {transcripts.length === 0 && (
                 <div
                   style={{
                     color: 'var(--text-muted)',
                     textAlign: 'center',
                     marginTop: '100px',
                     display: 'flex',
                     flexDirection: 'column',
                     alignItems: 'center',
                     gap: 16,
                     opacity: 0.8,
                   }}
                 >
                   <div style={{ transform: 'scale(1.5)', color: 'var(--primary-hover)' }}><Icons.Mic /></div>
                   <span style={{ fontSize: '1rem', fontWeight: 500 }}>音声を待機中...</span>
                 </div>
               )}
               {transcripts.map((row, i) => (
                 <div key={i} className={`msg ${row.isFinal ? 'final' : 'interim'}`}>
                   <div className="msg-time">
                     <span>{new Date(row.timestamp).toLocaleTimeString([], { hour12: false, minute:'2-digit', second:'2-digit' })}</span>
                     <span className="msg-latency">{row.latencyMs ? `${row.latencyMs}ms` : ''}</span>
                   </div>
                   <div className="msg-content">
                     {row.text}
                     {row.isFinal && <span className="msg-provider">{row.provider}</span>}
                   </div>
                 </div>
               ))}
               <div ref={transcriptEndRef} />
            </section>

            {/* Sidebar Stats */}
            <aside>
               <div className="card">
                 <h3>セッション統計</h3>
                 {isStreaming && (
                   <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, color: 'var(--error)', fontWeight: 700, fontSize: '0.8rem' }}>
                     <div className="pulse-dot" /> LIVE RECORDING
                   </div>
                 )}
                 <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                   <div className="stat-box">
                     <div className="stat-val">{fmt(realtimeSummary.avg)}<small>ms</small></div>
                     <div className="stat-label">平均レイテンシ</div>
                   </div>
                   <div className="stat-box">
                     <div className="stat-val">{fmt(realtimeSummary.p50)}<small>ms</small></div>
                     <div className="stat-label">レイテンシ (中央値)</div>
                   </div>
                   <div className="stat-box">
                     <div className="stat-val">{fmt(realtimeSummary.p95)}<small>ms</small></div>
                     <div className="stat-label">レイテンシ (95%値)</div>
                   </div>
                   <div className="stat-box">
                     <div className="stat-val">{latencies.length}</div>
                     <div className="stat-label">サンプル数</div>
                   </div>
                 </div>
               </div>
               <div className="card">
                 <div className="control-group">
                   <label>辞書 / コンテキスト (Dictionary)</label>
                   <textarea
                     value={dictionary}
                     onChange={(e) => setDictionary(e.target.value)}
                     placeholder="専門用語やフレーズを入力..."
                     rows={6}
                   />
                 </div>
               </div>
            </aside>
          </div>
        </div>
      )}

      {tab === 'batch' && (
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
                 <input id="file-upload" type="file" multiple onChange={(e) => setFiles(e.target.files)} style={{ display: 'none' }} />
               </div>
            </div>
            <div className="control-group">
              <label>プロバイダー</label>
              <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                {providers.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.available}>{p.id}</option>
                ))}
              </select>
            </div>
            <div className="control-group">
              <label>句読点</label>
              <select value={punctuationPolicy} onChange={(e) => setPunctuationPolicy(e.target.value as 'none' | 'basic' | 'full')}>
                {punctuationOptions.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </div>
            <div className="control-group">
              <label>並列数</label>
              <input type="number" min={1} max={8} value={parallel} onChange={(e) => setParallel(Number(e.target.value) || 1)} />
            </div>
            <div className="control-group">
               <button
                 className="btn btn-primary"
                 onClick={submitBatch}
                 disabled={!selectedProviderAvailable || isBatchRunning}
                 style={{ height: '44px' }}
               >
                 {isBatchRunning ? '処理中...' : <><Icons.Play /> ジョブ実行</>}
               </button>
            </div>
          </div>

          <div style={{ marginTop: '1.5rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
            <div className="control-group">
                <label>リファレンスJSON (正解データ)</label>
                <textarea
                  value={manifestJson}
                  onChange={(e) => setManifestJson(e.target.value)}
                  rows={3}
                  placeholder='例: {"version":1,"language":"ja-JP","items":[{"audio":"file1.wav","ref":"こんにちは"}]}'
                />
                <div className="muted">
                  CER/WERを計算するには入力が必要です。形式は manifest.example.json を参照。
                </div>
            </div>
            <div className="control-group">
               <label>辞書 / キーワード</label>
               <textarea value={dictionary} onChange={(e) => setDictionary(e.target.value)} rows={3} placeholder="キーワードを改行区切りで入力..." />
            </div>
          </div>

          {jobStatus && (
            <div style={{ marginTop: '2rem', padding: '1rem', background: 'var(--bg-subtle)', borderRadius: 'var(--radius)' }}>
              {(() => {
                const progress = jobStatus.total > 0 ? Math.round(((jobStatus.done + jobStatus.failed) / jobStatus.total) * 100) : 0;
                return (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem', marginBottom: 6, fontWeight: 600 }}>
                    <span>処理状況 (Job ID: {jobStatus.jobId})</span>
                    <span>{progress}%</span>
                  </div>
                );
              })()}
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
              <button className="btn btn-ghost" onClick={submitBatch} disabled={isBatchRunning}>リトライ</button>
            </div>
          )}
        </section>
      )}

      {(tab === 'batch' && jobSummary) || tab === 'results' ? (
        <section>
           {tab === 'results' && (
             <div className="card controls-grid" style={{ alignItems: 'center', marginBottom: '2rem' }}>
               <div className="control-group">
                 <label>プロバイダーでフィルタ</label>
                 <select value={resultsProviderFilter} onChange={(e) => setResultsProviderFilter(e.target.value)}>
                    <option value="all">全てのプロバイダー</option>
                    {resultProviderOptions.map(p => <option key={p} value={p}>{p}</option>)}
                 </select>
               </div>
               <div className="control-group">
                 <label>ファイル名検索</label>
                 <input type="search" placeholder="ファイル名を入力..." value={pathQuery} onChange={(e) => setPathQuery(e.target.value)} />
               </div>
             </div>
           )}

           {((tab === 'batch' && jobSummary) || tab === 'results') && (
             <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
               <div className="muted">最新ジョブID: {lastJobId ?? 'なし'}</div>
               <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                 <button className="btn btn-ghost" onClick={() => exportResults('csv')} disabled={!lastJobId}><Icons.Download /> CSV出力</button>
                 <button className="btn btn-ghost" onClick={() => exportResults('json')} disabled={!lastJobId}><Icons.Download /> JSON出力</button>
               </div>
             </div>
           )}

           {/* Metrics Grid */}
           {(jobSummary || filteredResults.length > 0) && (
             <>
               <h3 style={{ marginTop: '2rem' }}>パフォーマンス指標 (Performance Metrics)</h3>
               <div className="stat-grid">
                 <StatCard title="平均 CER (文字誤り率)" value={fmt((tab === 'batch' ? jobSummary : filteredSummary)?.cer.avg)} />
                 <StatCard title="平均 WER (単語誤り率)" value={fmt((tab === 'batch' ? jobSummary : filteredSummary)?.wer.avg)} />
                 <StatCard title="平均 RTF (実時間係数)" value={fmt((tab === 'batch' ? jobSummary : filteredSummary)?.rtf.avg)} />
                 <StatCard title="平均 レイテンシ" unit="ms" value={fmt((tab === 'batch' ? jobSummary : filteredSummary)?.latencyMs.avg)} />
               </div>
             </>
           )}

           {/* Charts */}
           {providerSummaries.length > 0 && (
             <div className="chart-grid">
                <QuantileChart title="CER (文字誤り率) 分布" unit="" summaries={providerSummaries} selector={(s) => s.cer} />
                <QuantileChart title="WER (単語誤り率) 分布" unit="" summaries={providerSummaries} selector={(s) => s.wer} />
                <QuantileChart title="レイテンシ 分布" unit="ms" summaries={providerSummaries} selector={(s) => s.latencyMs} />
             </div>
           )}

           {/* Detailed Table */}
           {filteredResults.length > 0 && (
             <div className="card" style={{ marginTop: '2rem', overflow: 'hidden', padding: 0 }}>
               <div style={{ padding: '1.5rem 1.5rem 0' }}>
                  <h3>詳細データ</h3>
               </div>
               <div style={{ overflowX: 'auto' }}>
                 <table>
                   <thead>
                     <tr>
                       <th>ファイル名</th>
                       <th>プロバイダー</th>
                       <th>CER</th>
                       <th>WER</th>
                       <th>RTF</th>
                       <th>レイテンシ</th>
                     </tr>
                   </thead>
                   <tbody>
                     {filteredResults.map((row) => (
                       <tr key={`${row.path}-${row.provider}`}>
                         <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 500 }}>{row.path}</td>
                         <td><span className="msg-provider">{row.provider}</span></td>
                         <td>{fmt(row.cer)}</td>
                         <td>{fmt(row.wer)}</td>
                         <td>{fmt(row.rtf)}</td>
                         <td>{row.latencyMs ? `${row.latencyMs}ms` : '-'}</td>
                       </tr>
                     ))}
                   </tbody>
                 </table>
               </div>
             </div>
           )}
        </section>
      ) : null}

      {/* Latency History Chart for Results Tab */}
      {tab === 'results' && latencyHistory.length > 0 && (
         <div className="latency-chart-wrapper" style={{ marginTop: '2rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', gap: '1rem', flexWrap: 'wrap' }}>
               <div>
                 <h3>リアルタイムレイテンシ履歴</h3>
                 <p className="muted" style={{ margin: 0 }}>直近 {latencyHistory.length} セッションの推移 (最新順)</p>
               </div>
               <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                 <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                   タイムゾーン
                   <select value={timezone} onChange={(e) => setTimezone(e.target.value as 'local' | 'utc')} style={{ padding: '4px 8px', borderRadius: 6 }}>
                     <option value="local">Local</option>
                     <option value="utc">UTC</option>
                   </select>
                 </label>
                 <button className="btn btn-ghost" onClick={() => refreshLatencyHistory()}><Icons.Refresh /> 更新</button>
                 <button className="btn btn-ghost" onClick={downloadLatencyCsv}><Icons.Download /> CSV</button>
               </div>
            </div>

            <LatencyHistoryChart history={latencyHistoryChrono} formatDate={formatDate} />

            <div style={{ overflowX: 'auto', marginTop: '1.5rem' }}>
              <table>
                <thead><tr><th>セッションID</th><th>プロバイダー</th><th>言語</th><th>サンプル数</th><th>中央値 (p50)</th><th>95%値 (p95)</th><th>平均</th><th>開始時刻</th></tr></thead>
                <tbody>
                  {latencyHistory.map(h => (
                    <tr key={h.sessionId}>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>{h.sessionId.slice(0,8)}</td>
                      <td><span className="msg-provider">{h.provider}</span></td>
                      <td>{h.lang}</td>
                      <td>{h.count}</td>
                      <td>{fmt(h.p50)}ms</td>
                      <td>{fmt(h.p95)}ms</td>
                      <td>{fmt(h.avg)}ms</td>
                      <td>{formatDate(h.startedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
         </div>
      )}
    </main>
  );
}

// --- Sub-components ---

function StatCard({ title, value, unit }: { title: string, value: string, unit?: string }) {
  return (
    <div className="stat-box">
       <div className="stat-val">{value}<small>{unit}</small></div>
       <div className="stat-label">{title}</div>
    </div>
  );
}

interface QuantileChartProps {
  title: string;
  unit?: string;
  summaries: { provider: string; summary: JobSummary }[];
  selector: (summary: JobSummary) => SummaryStats;
}

function QuantileChart({ title, unit = '', summaries, selector }: QuantileChartProps) {
  const max = Math.max(...summaries.map(({ summary }) => selector(summary).p95 ?? 0), 0);
  const safeMax = max > 0 ? max : 1;

  return (
    <div className="quantile-card">
      <div className="quantile-card__header" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h4 style={{ margin: 0, fontSize: '0.9rem' }}>{title}</h4>
        <div style={{ fontSize: '0.75rem', display: 'flex', gap: 12 }}>
          <span style={{ display: 'flex', alignItems: 'center' }}><span style={{ width: 8, height: 8, background: 'var(--primary)', borderRadius: 2, marginRight: 6 }}/> p50 (中央値)</span>
          <span style={{ display: 'flex', alignItems: 'center' }}><span style={{ width: 8, height: 8, background: '#bfdbfe', borderRadius: 2, marginRight: 6 }}/> p95</span>
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

// Improved Chart with Gradients and Better Scale
function LatencyHistoryChart({ history, formatDate }: { history: RealtimeLatencySummary[]; formatDate: (iso: string) => string }) {
  if (history.length === 0) return null;
  const data = history;
  const maxVal = Math.max(...data.flatMap((h) => [h.p95 ?? 0, h.p50 ?? 0]), 0);
  const safeMax = maxVal > 0 ? maxVal * 1.1 : 100; // Add 10% headroom
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  // Helper to generate path coordinates
  const getCoords = (key: keyof RealtimeLatencySummary) =>
    data.map((h, i) => {
      const x = data.length === 1 ? 50 : (i / (data.length - 1)) * 100;
      const val = (h[key] as number | null) ?? 0;
      const y = 100 - (val / safeMax) * 100;
      return [x, y] as [number, number];
    });

  const pointsP95 = getCoords('p95');
  const pointsP50 = getCoords('p50');

  const toPathStr = (pts: [number, number][]) => pts.map(p => `${p[0]},${p[1]}`).join(' ');
  const toAreaStr = (pts: [number, number][]) => `${pts[0][0]},100 ` + pts.map(p => `${p[0]},${p[1]}`).join(' ') + ` ${pts[pts.length-1][0]},100`;

  return (
    <div className="latency-chart">
      <div className="latency-chart__legend">
        <span style={{display: 'flex', alignItems: 'center'}}><span className="dot dot-p50" /> p50 (中央値)</span>
        <span style={{display: 'flex', alignItems: 'center'}}><span className="dot dot-p95" /> p95</span>
        <span className="muted" style={{marginLeft: 'auto'}}>Max: {Math.round(safeMax)} ms</span>
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
          {ticks.map((t) => {
            const y = 100 - t * 100;
            return <line key={t} x1="0" x2="100" y1={y} y2={y} strokeDasharray="2 2" />;
          })}
        </g>

        {/* Areas */}
        <polygon points={toAreaStr(pointsP95)} fill="url(#gradP95)" />
        <polygon points={toAreaStr(pointsP50)} fill="url(#gradP50)" />

        {/* Lines */}
        <polyline className="latency-line p95" points={toPathStr(pointsP95)} fill="none" />
        <polyline className="latency-line p50" points={toPathStr(pointsP50)} fill="none" />

        {/* Dots */}
        {data.map((h, idx) => {
          const x = data.length === 1 ? 50 : (idx / (data.length - 1)) * 100;
          const y50 = 100 - ((h.p50 ?? 0) / safeMax) * 100;
          const y95 = 100 - ((h.p95 ?? 0) / safeMax) * 100;
          const label = `${formatDate(h.startedAt)}\np50: ${fmt(h.p50)} ms\np95: ${fmt(h.p95)} ms`;
          return (
            <g key={h.sessionId}>
              <circle className="latency-dot p95" cx={x} cy={y95} r={1.5}><title>{label}</title></circle>
              <circle className="latency-dot p50" cx={x} cy={y50} r={1.5}><title>{label}</title></circle>
            </g>
          );
        })}

        <g className="latency-chart__ticks">
          {ticks.slice(1).map((t) => {
             const y = 100 - t * 100;
             return <text key={t} x="0" y={y + 3} fontSize="4" fill="#94a3b8">{Math.round(safeMax * t)}</text>;
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
