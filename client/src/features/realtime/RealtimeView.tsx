import { ChangeEvent, Dispatch, SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ControlPanel } from '../../components/ControlPanel';
import { Icons } from '../../components/icons';
import { StatCard } from '../../components/metrics';
import { TranscriptViewer } from '../../components/TranscriptViewer';
import { useAudioOutputDevices } from '../../hooks/useAudioOutputDevices';
import { useAudioRecorder } from '../../hooks/useAudioRecorder';
import { useRetry } from '../../hooks/useRetry';
import { useStreamSession } from '../../hooks/useStreamSession';
import { fmt, summarizeMetric } from '../../utils/metrics';
import type { ProviderInfo, PunctuationPolicy } from '../../types/app';

interface RealtimeViewProps {
  apiBase: string;
  chunkMs: number;
  provider: string;
  setProvider: (value: string) => void;
  providers: ProviderInfo[];
  dictionary: string;
  setDictionary: Dispatch<SetStateAction<string>>;
  dictionaryPhrases: string[];
  enableInterim: boolean;
  setEnableInterim: (value: boolean) => void;
  enableVad: boolean;
  setEnableVad: (value: boolean) => void;
  punctuationPolicy: PunctuationPolicy;
  setPunctuationPolicy: (value: PunctuationPolicy) => void;
  parallel: number;
  lang: string;
  setLang: (value: string) => void;
  sinkSelectionSupported: boolean;
  refreshLatencyHistory: () => Promise<void>;
  refreshLogSessions: () => Promise<void>;
}

const useRealtimeController = (props: RealtimeViewProps) => {
  const {
    apiBase,
    chunkMs,
    provider,
    setProvider,
    providers,
    dictionary,
    setDictionary,
    dictionaryPhrases,
    enableInterim,
    setEnableInterim,
    enableVad,
    setEnableVad,
    punctuationPolicy,
    setPunctuationPolicy,
    parallel,
    lang,
    setLang,
    sinkSelectionSupported,
    refreshLatencyHistory,
    refreshLogSessions,
  } = props;

  const selectedProviderInfo = useMemo(
    () => providers.find((item) => item.id === provider),
    [providers, provider]
  );

  const supportsDictionary = selectedProviderInfo?.supportsDictionaryPhrases !== false;
  const supportsContext = selectedProviderInfo?.supportsContextPhrases !== false;
  const supportsPunctuation = selectedProviderInfo?.supportsPunctuationPolicy !== false;

  const [inputSource, setInputSource] = useState<'mic' | 'file'>('mic');
  const [replayFile, setReplayFile] = useState<File | null>(null);
  const [replayUploading, setReplayUploading] = useState(false);
  const [replayAudioUrl, setReplayAudioUrl] = useState<string | null>(null);
  const [isReplayAudioPlaying, setIsReplayAudioPlaying] = useState(false);
  const [previewPlaybackWarning, setPreviewPlaybackWarning] = useState<string | null>(null);
  const [previewPlaybackError, setPreviewPlaybackError] = useState<string | null>(null);
  const [previewTranscoding, setPreviewTranscoding] = useState(false);
  const [previewSourceKind, setPreviewSourceKind] = useState<'local' | 'server' | null>(null);
  const [selectedOutputDeviceId, setSelectedOutputDeviceId] = useState<string | null>(null);
  const [isReplayAudioMuted, setIsReplayAudioMuted] = useState(false);
  const [outputSinkError, setOutputSinkError] = useState<string | null>(null);
  const replayAudioRef = useRef<HTMLAudioElement | null>(null);
  const replayAudioUrlRef = useRef<string | null>(null);
  const transcriptBodyRef = useRef<HTMLDivElement>(null);
  const [isAutoScroll, setIsAutoScroll] = useState(true);

  const releaseReplayAudioUrl = useCallback(() => {
    if (replayAudioUrlRef.current) {
      URL.revokeObjectURL(replayAudioUrlRef.current);
      replayAudioUrlRef.current = null;
    }
  }, []);

  const handleReplayAudioPlayChange = useCallback((playing: boolean) => {
    setIsReplayAudioPlaying(playing);
  }, []);

  const requestServerPreview = useCallback(async () => {
    if (!replayFile) {
      setPreviewPlaybackError('プレビューする音声ファイルがありません');
      return;
    }
    setPreviewTranscoding(true);
    setPreviewPlaybackWarning(null);
    setPreviewPlaybackError(null);
    try {
      const form = new FormData();
      form.append('file', replayFile, replayFile.name);
      const response = await fetch(`${apiBase}/api/realtime/preview`, { method: 'POST', body: form });
      if (!response.ok) {
        const text = await response.text();
        try {
          const parsed = JSON.parse(text) as { message?: string; detail?: string; code?: string };
          const detail = parsed.detail ?? parsed.message;
          throw new Error(detail ?? 'プレビュー用の変換に失敗しました');
        } catch {
          throw new Error('プレビュー用の変換に失敗しました');
        }
      }
      const data = (await response.json()) as { previewUrl: string; degraded?: boolean };
      const absoluteUrl = data.previewUrl.startsWith('http')
        ? data.previewUrl
        : `${apiBase}${data.previewUrl.startsWith('/') ? '' : '/'}${data.previewUrl}`;
      replayAudioUrlRef.current = null;
      setReplayAudioUrl(absoluteUrl);
      setPreviewSourceKind('server');
      setPreviewPlaybackWarning(
        data.degraded
          ? '音声ファイルに一部破損がありましたが再生用に変換しました（精度に影響する可能性があります）'
          : null
      );
    } catch (error) {
      setPreviewSourceKind('local');
      setPreviewPlaybackWarning(null);
      setPreviewPlaybackError((error as Error)?.message ?? 'プレビュー用の変換に失敗しました');
    } finally {
      setPreviewTranscoding(false);
    }
  }, [apiBase, replayFile]);

  const handleReplayAudioError = useCallback(() => {
    if (!replayFile) {
      setPreviewPlaybackError('音声ファイルが選択されていません');
      return;
    }
    if (previewSourceKind === 'server' || previewTranscoding) {
      setPreviewPlaybackError('ブラウザが音声を再生できませんでした。ファイル形式を確認してください。');
      return;
    }
    void requestServerPreview();
  }, [previewSourceKind, previewTranscoding, replayFile, requestServerPreview]);

  const {
    devices: audioOutputDevices,
    loading: audioOutputDevicesLoading,
    error: audioOutputDevicesError,
    hasDevices: hasAudioOutputDevices,
    refresh: refreshAudioOutputDevices,
  } = useAudioOutputDevices();

  const {
    devices: audioDevices,
    hasDevices,
    loading: audioDevicesLoading,
    error: audioDevicesError,
    refreshDevices,
    selectedAudioDeviceId,
    setSelectedAudioDeviceId,
    selectedAudioDeviceLabel,
    micPermission,
    refreshMicPermission,
  } = useAudioRecorder();

  useEffect(() => {
    setSelectedOutputDeviceId((current) => {
      if (!current) return null;
      if (audioOutputDevices.some((device) => device.deviceId === current)) return current;
      return null;
    });
  }, [audioOutputDevices]);

  useEffect(() => {
    const audio = replayAudioRef.current;
    if (!audio) return;
    audio.muted = isReplayAudioMuted;
    if (!replayAudioUrl || !sinkSelectionSupported) {
      return;
    }
    const media = audio as HTMLMediaElement & { setSinkId?: (sinkId: string) => Promise<void> };
    const setter = media.setSinkId;
    if (!setter) {
      setOutputSinkError(null);
      return;
    }
    setOutputSinkError(null);
    void setter
      .call(media, selectedOutputDeviceId ?? '')
      .catch((error) => {
        console.error('setSinkId failed', error);
        setOutputSinkError((error as Error)?.message ?? '出力先の切り替えに失敗しました');
      });
  }, [isReplayAudioMuted, replayAudioUrl, selectedOutputDeviceId, sinkSelectionSupported]);

  useEffect(() => {
    const container = transcriptBodyRef.current;
    if (!container) return;
    const handleScroll = () => {
      const inBottom = container.scrollHeight - (container.scrollTop + container.clientHeight) < 16;
      setIsAutoScroll(inBottom);
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, []);

  useEffect(() => () => {
    releaseReplayAudioUrl();
  }, [releaseReplayAudioUrl]);

  const punctuationOptions = useMemo<PunctuationPolicy[]>(() => {
    if (!supportsPunctuation) {
      return ['none'];
    }
    if (selectedProviderInfo?.id === 'deepgram') {
      return ['none', 'full'];
    }
    return ['none', 'basic', 'full'];
  }, [selectedProviderInfo?.id, supportsPunctuation]);

  useEffect(() => {
    if (!supportsPunctuation) {
      if (punctuationPolicy !== 'none') {
        setPunctuationPolicy('none');
      }
      return;
    }
    if (!punctuationOptions.includes(punctuationPolicy)) {
      setPunctuationPolicy(punctuationOptions[punctuationOptions.length - 1]);
    }
  }, [supportsPunctuation, punctuationOptions, punctuationPolicy, setPunctuationPolicy]);

  const buildStreamingConfig = useCallback(() => {
    const options: {
      enableVad: boolean;
      punctuationPolicy: PunctuationPolicy;
      parallel: number;
      dictionaryPhrases?: string[];
    } = {
      enableVad,
      punctuationPolicy,
      parallel,
    };
    if (supportsDictionary && dictionaryPhrases.length > 0) {
      options.dictionaryPhrases = dictionaryPhrases;
    }
    return {
      type: 'config',
      enableInterim,
      contextPhrases: supportsContext ? dictionaryPhrases : undefined,
      options,
    };
  }, [
    dictionaryPhrases,
    enableInterim,
    enableVad,
    parallel,
    punctuationPolicy,
    supportsContext,
    supportsDictionary,
  ]);

  const wsBase = useMemo(() => apiBase.replace(/^http/, 'ws').replace(/\/$/, ''), [apiBase]);
  const buildWsUrl = useCallback(
    (path: 'stream' | 'replay', sessionId?: string) => {
      const params = new URLSearchParams({ provider, lang });
      if (sessionId) params.set('sessionId', sessionId);
      return `${wsBase}/ws/${path}?${params.toString()}`;
    },
    [lang, provider, wsBase]
  );

  const realtimeRetry = useRetry({ maxAttempts: 3, baseDelayMs: 1000 });
  const streamSession = useStreamSession({
    chunkMs,
    apiBase,
    buildStreamingConfig,
    buildWsUrl,
    retry: realtimeRetry,
    onSessionClose: () => {
      void refreshLatencyHistory();
      void refreshLogSessions();
    },
  });

  useEffect(() => {
    if (inputSource !== 'file' || !streamSession.isStreaming || !replayAudioUrl) {
      return undefined;
    }
    const audio = replayAudioRef.current;
    if (!audio) return undefined;
    audio.currentTime = 0;
    void audio.play().catch((error) => {
      if ((error as DOMException)?.name === 'AbortError') return; // play が直後の pause で中断された場合は無視
      console.warn('内部再生音声の自動再生に失敗しました', error);
    });
    return () => {
      audio.pause();
      audio.currentTime = 0;
      setIsReplayAudioPlaying(false);
    };
  }, [inputSource, replayAudioUrl, streamSession.isStreaming]);

  useEffect(() => {
    if (streamSession.transcripts.length === 0 || !isAutoScroll) return;
    const container = transcriptBodyRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  }, [streamSession.transcripts, isAutoScroll]);

  const jumpToBottom = useCallback(() => {
    const container = transcriptBodyRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    setIsAutoScroll(true);
  }, []);

  const realTimeSummary = useMemo(() => summarizeMetric(streamSession.latencies), [streamSession.latencies]);

  const selectedProvider = useMemo(() => providers.find((item) => item.id === provider), [providers, provider]);
  const selectedProviderAvailable = selectedProvider?.available ?? true;
  const selectedProviderStreamingReady = selectedProviderAvailable && (selectedProvider?.supportsStreaming ?? true);

  const micPermissionLabel = useMemo(() => {
    switch (micPermission) {
      case 'granted': return '許可済み';
      case 'prompt': return '許可待ち';
      case 'denied': return '拒否';
      default: return '不明';
    }
  }, [micPermission]);

  const micPermissionHint = useMemo(() => {
    switch (micPermission) {
      case 'granted':
        return 'マイク権限は付与されています。録音ボタンを押してセッションを開始できます。';
      case 'prompt':
        return '権限ダイアログが表示されていない場合、ページを再読み込みしてから許可してください。';
      case 'denied':
        return 'ブラウザ設定でマイクを許可してください。';
      default:
        return 'マイク権限の状態を確認中です。';
    }
  }, [micPermission]);

  const handleReplayFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setReplayFile(file);
    streamSession.setError(null);
    releaseReplayAudioUrl();
    setIsReplayAudioPlaying(false);
    setOutputSinkError(null);
    setPreviewPlaybackError(null);
    setPreviewPlaybackWarning(null);
    setPreviewTranscoding(false);
    setPreviewSourceKind(file ? 'local' : null);
    if (file) {
      const url = URL.createObjectURL(file);
      replayAudioUrlRef.current = url;
      setReplayAudioUrl(url);
    } else {
      setReplayAudioUrl(null);
    }
  };

  const handleStart = () => {
    streamSession.setError(null);
    if (!selectedProviderStreamingReady) {
      streamSession.setError('このプロバイダはRealtime非対応か現在利用できません（Batchタブをご利用ください）');
      return;
    }
    if (inputSource === 'mic') {
      if (micPermission === 'denied') {
        streamSession.setError('ブラウザのマイクが拒否されています。権限設定を見直してください。');
        return;
      }
      if (!hasDevices) {
        streamSession.setError('マイクデバイスが見つかりません。接続とリフレッシュをお試しください。');
        return;
      }
      void streamSession.startMic(selectedAudioDeviceId ?? undefined);
    } else {
      if (!replayFile) {
        streamSession.setError('再生ファイルを選択してください');
        return;
      }
      if (previewPlaybackError) {
        streamSession.setError(previewPlaybackError);
        return;
      }
      setPreviewPlaybackError(null);
      const previewAudio = replayAudioRef.current;
      if (previewAudio) {
        void previewAudio.play().catch((error) => {
          if ((error as DOMException)?.name === 'AbortError') return; // play→pause の競合は警告しない
          console.warn('プレビュー音声の再生に失敗しました', error);
          setPreviewPlaybackError('ブラウザが自動再生を拒否しました。プレビューの再生ボタンを押してからもう一度実行してください。');
        });
      } else {
        setPreviewPlaybackError('音声プレビューの初期化が完了していません。ファイルを選びなおして再実行してください。');
      }
      setReplayUploading(true);
      void streamSession.startReplay(replayFile, { provider, lang }).finally(() => {
        setReplayUploading(false);
      });
    }
  };

  const stopRealtime = () => {
    streamSession.stop();
  };

  const startDisabled = streamSession.isStreaming
    ? false
    : !selectedProviderAvailable
      || !selectedProviderStreamingReady
      || (inputSource === 'file' && (!replayFile || replayUploading));

  const startLabel = streamSession.isStreaming
    ? 'ストリーミング停止'
    : inputSource === 'mic'
      ? '録音開始'
      : '内部ファイル再生';

  const startIcon = streamSession.isStreaming
    ? <Icons.Stop />
    : inputSource === 'mic'
      ? <Icons.Mic />
      : <Icons.Play />;

  const statCards = (
    <div className="stat-grid">
      <StatCard title="平均レイテンシ" value={fmt(realTimeSummary.avg)} unit="ms" />
      <StatCard title="レイテンシ (p50)" value={fmt(realTimeSummary.p50)} unit="ms" />
      <StatCard title="レイテンシ (p95)" value={fmt(realTimeSummary.p95)} unit="ms" />
      <StatCard title="サンプル数" value={`${streamSession.latencies.length}`} />
    </div>
  );

  const controlPanelProps = {
    provider,
    providers,
    onProviderChange: setProvider,
    inputSource,
    setInputSource,
    isStreaming: streamSession.isStreaming,
    selectedProviderAvailable,
    selectedProviderStreamingReady,
    audioDevices,
    selectedAudioDeviceId,
    setSelectedAudioDeviceId,
    hasDevices,
    audioDevicesLoading,
    audioDevicesError,
    refreshAudioDevices: refreshDevices,
    micPermission,
    refreshMicPermission,
    micPermissionLabel,
    micPermissionHint,
    lang,
    setLang,
    punctuationPolicy,
    setPunctuationPolicy,
    punctuationOptions,
    enableInterim,
    setEnableInterim,
    enableVad,
    setEnableVad,
    replayFile,
    handleReplayFileChange,
    replayUploading,
    replayAudioUrl,
    replayAudioRef,
    replayAudioPlaying: isReplayAudioPlaying,
    onReplayAudioPlayChange: handleReplayAudioPlayChange,
    onReplayAudioError: handleReplayAudioError,
    previewPlaybackError,
    previewPlaybackWarning,
    setPreviewPlaybackError,
    previewTranscoding,
    dictionary,
    setDictionary,
    audioOutputDevices,
    audioOutputDevicesLoading,
    audioOutputDevicesError,
    hasAudioOutputDevices,
    refreshAudioOutputDevices,
    selectedOutputDeviceId,
    setSelectedOutputDeviceId,
    isReplayAudioMuted,
    setIsReplayAudioMuted,
    sinkSelectionSupported,
    outputSinkError,
    selectedAudioDeviceLabel,
  };

  return {
    controlPanelProps,
    streamSession,
    transcriptBodyRef,
    statCards,
    isAutoScroll,
    startDisabled,
    startLabel,
    startIcon,
    handleStart,
    stopRealtime,
    jumpToBottom,
    previewPlaybackError,
    setPreviewPlaybackError,
    replayUploading,
  };
};

export const RealtimeView = (props: RealtimeViewProps) => {
  const {
    controlPanelProps,
    streamSession,
    transcriptBodyRef,
    statCards,
    isAutoScroll,
    startDisabled,
    startLabel,
    startIcon,
    handleStart,
    stopRealtime,
    jumpToBottom,
  } = useRealtimeController(props);

  return (
    <>
      {streamSession.error && (
        <div className="banner error">
          <Icons.Alert />
          <div>
            <div style={{ fontWeight: 'bold' }}>エラーが発生しました</div>
            <div style={{ fontSize: '0.85rem' }}>{streamSession.error}</div>
          </div>
        </div>
      )}
      <div className="realtime-grid">
        <div className="control-column">
          <ControlPanel {...controlPanelProps} />
        </div>
        <div className="transcript-column">
          <TranscriptViewer
            transcripts={streamSession.transcripts}
            containerRef={transcriptBodyRef}
            showJumpButton={!isAutoScroll && streamSession.transcripts.length > 0}
            onJumpToBottom={jumpToBottom}
          />
          {statCards}
        </div>
      </div>
      <div className="floating-action">
        <div className="floating-action__panel">
          <button
            type="button"
            className="floating-action__btn"
            onClick={streamSession.isStreaming ? stopRealtime : handleStart}
            disabled={startDisabled}
          >
            {startIcon}
            {startLabel}
          </button>
          <div className={`floating-action__meter ${streamSession.isStreaming ? 'active' : ''}`}>
            <span />
            <span />
            <span />
          </div>
        </div>
      </div>
    </>
  );
};
