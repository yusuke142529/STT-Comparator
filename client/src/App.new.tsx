import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Icons } from './components/icons';
import { parseDictionary } from './utils/parseDictionary';
import { fetchJson } from './utils/fetchJson';
import { useBatchJobManager } from './hooks/useBatchJobManager';
import { useRetry } from './hooks/useRetry';
import { STYLES } from './styles/theme';
import { RealtimeView } from './features/realtime/RealtimeView';
import { VoiceView } from './features/voice/VoiceView';
import { BatchView } from './features/batch/BatchView';
import { ResultsView } from './features/results/ResultsView';
import type {
  ProviderInfo,
  PunctuationPolicy,
  RealtimeLatencySummary,
  RealtimeLogEntry,
  RealtimeLogSession,
} from './types/app';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4100';
const sinkSelectionSupported =
  typeof HTMLMediaElement !== 'undefined' &&
  typeof (HTMLMediaElement.prototype as HTMLMediaElement & { setSinkId?: (sinkId: string) => Promise<void> }).setSinkId === 'function';

const tabMeta = [
  { id: 'realtime', label: 'リアルタイム' },
  { id: 'voice', label: '音声会話' },
  { id: 'batch', label: 'バッチ処理' },
  { id: 'results', label: '結果分析' },
] as const;

export default function App() {
  const [primaryProvider, setPrimaryProvider] = useState('deepgram');
  const [secondaryProvider, setSecondaryProvider] = useState<string | null>(null);
  const [batchCompareMode, setBatchCompareMode] = useState(false);
  const [lang, setLang] = useState('ja-JP');
  const [dictionary, setDictionary] = useState('');
  const [enableInterim, setEnableInterim] = useState(true);
  const [enableVad, setEnableVad] = useState(false);
  const [enableDiarization, setEnableDiarization] = useState(false);
  const [enableChannelSplit, setEnableChannelSplit] = useState(false);
  const [meetingMode, setMeetingMode] = useState(false);
  const [punctuationPolicy, setPunctuationPolicy] = useState<PunctuationPolicy>('full');
  const [parallel, setParallel] = useState(1);
  const [chunkMs, setChunkMs] = useState(250);
  const [tab, setTab] = useState<'realtime' | 'voice' | 'batch' | 'results'>('realtime');
  const [providerWarning, setProviderWarning] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([
    { id: 'deepgram', available: true, implemented: true, supportsStreaming: true, supportsBatch: true },
    { id: 'local_whisper', available: true, implemented: true, supportsStreaming: false, supportsBatch: true },
    { id: 'whisper_streaming', available: true, implemented: true, supportsStreaming: true, supportsBatch: true },
  ]);
  const [lastJobId, setLastJobId] = useState<string | null>(null);
  const [latencyHistory, setLatencyHistory] = useState<RealtimeLatencySummary[]>([]);
  const [logSessions, setLogSessions] = useState<RealtimeLogSession[]>([]);
  const [logSessionsLoading, setLogSessionsLoading] = useState(false);
  const [logSessionsError, setLogSessionsError] = useState<string | null>(null);
  const [logEntries, setLogEntries] = useState<RealtimeLogEntry[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [selectedLogSessionId, setSelectedLogSessionId] = useState<string | null>(null);

  const dictionaryPhrases = useMemo(() => parseDictionary(dictionary), [dictionary]);

  const batchRetry = useRetry({ maxAttempts: 2, baseDelayMs: 1000 });
  const {
    jobStatus,
    jobResults,
    jobSummary,
    jobHistory,
    jobHistoryError,
    jobError,
    isBatchRunning,
    submitBatch,
    loadJobData,
    refreshJobHistory,
  } = useBatchJobManager({ apiBase: API_BASE, retry: batchRetry, onJobLoaded: setLastJobId });

  useEffect(() => {
    const styleElement = document.createElement('style');
    styleElement.dataset.sttComparator = 'modern-theme';
    styleElement.textContent = STYLES;
    document.head.appendChild(styleElement);
    return () => {
      document.head.removeChild(styleElement);
    };
  }, []);

  useEffect(() => {
    const loadProviders = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/providers`);
        if (!res.ok) throw new Error('プロバイダ情報の取得に失敗しました');
        const data = (await res.json()) as ProviderInfo[];
        setProviders(data);
        const firstAvailable = data.find((item) => item.available)?.id;
        if (firstAvailable && !data.find((item) => item.id === primaryProvider && item.available)) {
          setPrimaryProvider(firstAvailable);
        }
        const secondCandidate = data.find((item) => item.available && item.id !== firstAvailable)?.id;
        if (!secondaryProvider && secondCandidate) {
          setSecondaryProvider(secondCandidate);
        }
        const warning = data
          .filter((item) => !item.available && item.reason)
          .map((item) => `${item.id}: ${item.reason}`)
          .shift();
        setProviderWarning(warning ?? null);
      } catch (error) {
        console.error(error);
        setProviderWarning((error as Error).message);
      }
    };

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

    void loadProviders();
    void loadConfig();
  }, [primaryProvider, secondaryProvider]);

  const refreshLatencyHistory = useCallback(async () => {
    try {
      const data = await fetchJson<RealtimeLatencySummary[]>(`${API_BASE}/api/realtime/latency?limit=20`);
      setLatencyHistory(data);
    } catch (error) {
      console.warn('latency history fetch failed', error);
    }
  }, []);

  const refreshLogSessions = useCallback(async () => {
    setLogSessionsLoading(true);
    setLogSessionsError(null);
    try {
      const data = await fetchJson<RealtimeLogSession[]>(`${API_BASE}/api/realtime/log-sessions?limit=50`);
      setLogSessions(data);
    } catch (error) {
      console.warn('log sessions fetch failed', error);
      setLogSessionsError((error as Error).message);
    } finally {
      setLogSessionsLoading(false);
    }
  }, []);

  const fetchRealtimeLogs = useCallback(
    async (sessionId: string) => {
      setSelectedLogSessionId(sessionId);
      setLogLoading(true);
      setLogError(null);
      setLogEntries([]);
      try {
        const data = await fetchJson<RealtimeLogEntry[]>(`${API_BASE}/api/realtime/logs/${sessionId}`);
        setLogEntries(data);
      } catch (error) {
        setLogEntries([]);
        setLogError((error as Error).message);
      } finally {
        setLogLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (tab === 'results') {
      void refreshLatencyHistory();
      void refreshJobHistory();
      void refreshLogSessions();
    }
  }, [tab, refreshJobHistory, refreshLatencyHistory, refreshLogSessions]);

  const exportResults = useCallback(
    (format: 'csv' | 'json') => {
      if (!lastJobId) return;
      const suffix = format === 'csv' ? '?format=csv' : '?format=json';
      const url = `${API_BASE}/api/jobs/${lastJobId}/results${suffix}`;
      window.open(url, '_blank');
    },
    [lastJobId]
  );

  const activeTabIndex = tabMeta.findIndex((entry) => entry.id === tab);
  const tabStyles = {
    '--active-tab': String(activeTabIndex),
    '--tabs': String(tabMeta.length),
  } as unknown as CSSProperties;

  return (
    <div className="app-shell">
      <header className="glass-header">
        <div className="app-title">
          <h1>STT Comparator</h1>
          <p className="subtitle">Voice Recognition Evaluation Tool v1.0</p>
        </div>
        <nav className="tabs" style={tabStyles}>
          <span className="tab-indicator" />
          {tabMeta.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="tab-button"
              aria-current={tab === entry.id ? 'page' : undefined}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </nav>
      </header>

      {providerWarning && (
        <div className="banner warning">
          <Icons.Alert />
          <div>{providerWarning}</div>
        </div>
      )}

      {tab === 'realtime' && (
        <RealtimeView
          apiBase={API_BASE}
          chunkMs={chunkMs}
          primaryProvider={primaryProvider}
          secondaryProvider={secondaryProvider}
          setPrimaryProvider={setPrimaryProvider}
          setSecondaryProvider={setSecondaryProvider}
          providers={providers}
          dictionary={dictionary}
          setDictionary={setDictionary}
          dictionaryPhrases={dictionaryPhrases}
          enableInterim={enableInterim}
          setEnableInterim={setEnableInterim}
          enableVad={enableVad}
          setEnableVad={setEnableVad}
          enableDiarization={enableDiarization}
          setEnableDiarization={setEnableDiarization}
          enableChannelSplit={enableChannelSplit}
          setEnableChannelSplit={setEnableChannelSplit}
          meetingMode={meetingMode}
          setMeetingMode={setMeetingMode}
          punctuationPolicy={punctuationPolicy}
          setPunctuationPolicy={setPunctuationPolicy}
          parallel={parallel}
          lang={lang}
          setLang={setLang}
          sinkSelectionSupported={sinkSelectionSupported}
          refreshLatencyHistory={refreshLatencyHistory}
          refreshLogSessions={refreshLogSessions}
        />
      )}

      {tab === 'voice' && <VoiceView apiBase={API_BASE} lang={lang} />}

      {tab === 'batch' && (
        <BatchView
          primaryProvider={primaryProvider}
          setPrimaryProvider={setPrimaryProvider}
          secondaryProvider={secondaryProvider}
          setSecondaryProvider={setSecondaryProvider}
          compareMode={batchCompareMode}
          setCompareMode={setBatchCompareMode}
          providers={providers}
          dictionary={dictionary}
          setDictionary={setDictionary}
          dictionaryPhrases={dictionaryPhrases}
          enableVad={enableVad}
          punctuationPolicy={punctuationPolicy}
          setPunctuationPolicy={setPunctuationPolicy}
          parallel={parallel}
          setParallel={setParallel}
          lang={lang}
          submitBatch={submitBatch}
          jobStatus={jobStatus}
          jobError={jobError}
          isBatchRunning={isBatchRunning}
          jobResults={jobResults}
          lastJobId={lastJobId}
        />
      )}

      {tab === 'results' && (
        <ResultsView
          jobHistory={jobHistory}
          jobHistoryError={jobHistoryError}
          jobSummary={jobSummary}
          jobResults={jobResults}
          lastJobId={lastJobId}
          loadJobData={loadJobData}
          refreshJobHistory={refreshJobHistory}
          exportResults={exportResults}
          latencyHistory={latencyHistory}
          refreshLatencyHistory={refreshLatencyHistory}
          logSessions={logSessions}
          logSessionsLoading={logSessionsLoading}
          logSessionsError={logSessionsError}
          refreshLogSessions={refreshLogSessions}
          fetchRealtimeLogs={fetchRealtimeLogs}
          logEntries={logEntries}
          logLoading={logLoading}
          logError={logError}
          selectedLogSessionId={selectedLogSessionId}
        />
      )}
    </div>
  );
}
