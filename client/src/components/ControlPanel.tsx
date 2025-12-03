import {
  ChangeEvent,
  Dispatch,
  SetStateAction,
  memo,
  useMemo,
  useState,
  type RefObject,
} from 'react';
import { Icons } from './icons';
import { ToggleSwitch } from './ToggleSwitch';
import type { ProviderInfo, PunctuationPolicy } from '../types/app';
import type { MicrophonePermissionStatus } from '../hooks/useMicrophonePermission';
import type { AudioOutputDevice } from '../hooks/useAudioOutputDevices';

interface ControlPanelProps {
  provider: string;
  providers: ProviderInfo[];
  onProviderChange: (value: string) => void;
  inputSource: 'mic' | 'file';
  setInputSource: (value: 'mic' | 'file') => void;
  isStreaming: boolean;
  selectedProviderAvailable: boolean;
  selectedProviderStreamingReady: boolean;
  audioDevices: Array<{ deviceId: string; label: string }>;
  selectedAudioDeviceId: string | null;
  setSelectedAudioDeviceId: (value: string | null) => void;
  hasDevices: boolean;
  audioDevicesLoading: boolean;
  audioDevicesError: string | null;
  refreshAudioDevices: () => void;
  micPermission: MicrophonePermissionStatus;
  refreshMicPermission: () => void;
  micPermissionLabel: string;
  micPermissionHint: string;
  selectedAudioDeviceLabel: string;
  lang: string;
  setLang: (value: string) => void;
  punctuationPolicy: PunctuationPolicy;
  setPunctuationPolicy: (value: PunctuationPolicy) => void;
  enableInterim: boolean;
  setEnableInterim: (value: boolean) => void;
  enableVad: boolean;
  setEnableVad: (value: boolean) => void;
  allowDegraded: boolean;
  setAllowDegraded: (value: boolean) => void;
  replayFile: File | null;
  handleReplayFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  replayUploading: boolean;
  replayAudioUrl: string | null;
  replayAudioRef: RefObject<HTMLAudioElement>;
  replayAudioPlaying: boolean;
  onReplayAudioPlayChange: (playing: boolean) => void;
  onReplayAudioError: () => void;
  previewPlaybackError: string | null;
  previewPlaybackWarning: string | null;
  setPreviewPlaybackError: (value: string | null) => void;
  previewTranscoding: boolean;
  punctuationOptions: PunctuationPolicy[];
  dictionary: string;
  setDictionary: Dispatch<SetStateAction<string>>;
  audioOutputDevices: AudioOutputDevice[];
  audioOutputDevicesLoading: boolean;
  audioOutputDevicesError: string | null;
  hasAudioOutputDevices: boolean;
  refreshAudioOutputDevices: () => void;
  selectedOutputDeviceId: string | null;
  setSelectedOutputDeviceId: (value: string | null) => void;
  isReplayAudioMuted: boolean;
  setIsReplayAudioMuted: (value: boolean) => void;
  sinkSelectionSupported: boolean;
  outputSinkError: string | null;
}

export const ControlPanel = memo(({
  provider,
  providers,
  onProviderChange,
  inputSource,
  setInputSource,
  isStreaming,
  selectedProviderAvailable,
  selectedProviderStreamingReady,
  audioDevices,
  selectedAudioDeviceId,
  setSelectedAudioDeviceId,
  hasDevices,
  audioDevicesLoading,
  audioDevicesError,
  refreshAudioDevices,
  micPermission,
  refreshMicPermission,
  micPermissionLabel,
  micPermissionHint,
  selectedAudioDeviceLabel,
  lang,
  setLang,
  punctuationPolicy,
  setPunctuationPolicy,
  punctuationOptions,
  enableInterim,
  setEnableInterim,
  enableVad,
  setEnableVad,
  allowDegraded,
  setAllowDegraded,
  replayFile,
  handleReplayFileChange,
  replayUploading,
  replayAudioUrl,
  replayAudioRef,
  replayAudioPlaying,
  onReplayAudioPlayChange,
  onReplayAudioError,
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
  }: ControlPanelProps) => {
  const [sections, setSections] = useState({
    input: true,
    provider: true,
    advanced: true,
  });

  const toggleSection = (section: keyof typeof sections) => {
    setSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  const selectedProviderInfo = useMemo(() => providers.find((item) => item.id === provider), [providers, provider]);

  const dictionaryDisabled = selectedProviderInfo?.supportsDictionaryPhrases === false;
  const punctuationDisabled = selectedProviderInfo?.supportsPunctuationPolicy === false;

  const realtimeNote = !selectedProviderAvailable
    ? 'このプロバイダは現在利用できません。'
    : !selectedProviderStreamingReady
      ? 'このプロバイダはRealtime非対応です。Batchタブをご利用ください。'
      : null;

  const inputHint = inputSource === 'mic'
    ? '選択したマイクからリアルタイム音声を送信します。'
    : '内部ファイルを選択するとMediaRecorder経路を再現し、プレビューで音声を再生できます。';

  return (
    <section className="control-panel">
      <article className="panel-card" data-state={sections.input ? 'open' : 'closed'}>
        <button type="button" className="panel-card__header" onClick={() => toggleSection('input')}>
          <span>入力ソース</span>
          <span className="panel-card__chevron">{sections.input ? '▾' : '▸'}</span>
        </button>
        <div className="panel-card__body" aria-hidden={!sections.input}>
          <div className="field">
            <label>プロバイダー</label>
            <select value={provider} onChange={(event) => onProviderChange(event.target.value)}>
              {providers.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.available}>
                  {p.id}
                  {!p.available ? ' (利用不可)' : ''}
                </option>
              ))}
            </select>
            {selectedProviderInfo?.reason && <p className="helper-text">{selectedProviderInfo.reason}</p>}
            {selectedProviderInfo?.id === 'openai' && (
              <p className="helper-text">OpenAI はサーバ側で 16kHz → 24kHz に変換して送信します（OPENAI_API_KEY が必要）。</p>
            )}
            {realtimeNote && <p className="helper-text">{realtimeNote}</p>}
          </div>
          <div className="field">
            <label>入力モード</label>
            <div className="source-toggle">
              <button
                type="button"
                className={`source-pill ${inputSource === 'mic' ? 'active' : ''}`}
                onClick={() => setInputSource('mic')}
                disabled={isStreaming}
              >
                マイク
              </button>
              <button
                type="button"
                className={`source-pill ${inputSource === 'file' ? 'active' : ''}`}
                onClick={() => setInputSource('file')}
                disabled={isStreaming}
              >
                内部ファイル
              </button>
            </div>
            <p className="helper-text">{inputHint}</p>
          </div>
          {inputSource === 'mic' ? (
            <div className="field">
              <label>マイク選択</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select
                  value={selectedAudioDeviceId ?? ''}
                  disabled={audioDevicesLoading || !hasDevices || isStreaming}
                  onChange={(event) => setSelectedAudioDeviceId(event.target.value || null)}
                >
                  <option value="" disabled>
                    {hasDevices ? 'マイクを選択してください' : 'マイクがありません'}
                  </option>
                  {audioDevices.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={refreshAudioDevices}
                  disabled={audioDevicesLoading}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  <Icons.Refresh /> 更新
                </button>
              </div>
              <p className="helper-text">{selectedAudioDeviceLabel}</p>
              {!audioDevicesLoading && !hasDevices && (
                <p className="helper-text">マイクが検出されません。OS/ブラウザ設定をご確認ください。</p>
              )}
              {audioDevicesError && <p className="helper-text">{audioDevicesError}</p>}
            </div>
          ) : (
            <div className="field">
              <label>内部再生ファイル</label>
              <input
                type="file"
                accept="audio/*"
                onChange={handleReplayFileChange}
                disabled={replayUploading || isStreaming}
              />
              <p className="helper-text">{replayFile ? replayFile.name : 'ファイル未選択'}</p>
              {replayAudioUrl && (
                <>
                  <audio
                    ref={replayAudioRef}
                    src={replayAudioUrl}
                    controls
                    preload="auto"
                    style={{ width: '100%', marginTop: 8 }}
                    onPlay={() => onReplayAudioPlayChange(true)}
                    onPause={() => onReplayAudioPlayChange(false)}
                    onEnded={() => onReplayAudioPlayChange(false)}
                    onError={() => {
                      onReplayAudioError();
                      onReplayAudioPlayChange(false);
                    }}
                  />
                  <p className="helper-text">
                    {replayAudioPlaying
                      ? '内部再生音声を再生中です'
                      : '再生ボタンで音声を確認できます。ストリーミング開始時にも自動再生されます。'}
                  </p>
                  {previewTranscoding && (
                    <p className="helper-text">ブラウザ非対応の形式でした。互換フォーマットへ変換中です…</p>
                  )}
                  {previewPlaybackWarning && (
                    <p className="helper-text">{previewPlaybackWarning}</p>
                  )}
                  {previewPlaybackError && (
                    <p className="helper-text">{previewPlaybackError}</p>
                  )}
                  <div className="field" style={{ paddingTop: 6 }}>
                    <label>出力先</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <select
                        value={selectedOutputDeviceId ?? ''}
                        onChange={(event) => setSelectedOutputDeviceId(event.target.value || null)}
                        disabled={!sinkSelectionSupported || audioOutputDevicesLoading}
                      >
                        <option value="">システム既定 (ブラウザ/OS)</option>
                        {audioOutputDevices.map((device) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {device.label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={refreshAudioOutputDevices}
                        disabled={audioOutputDevicesLoading}
                        style={{ whiteSpace: 'nowrap' }}
                      >
                        <Icons.Refresh /> 更新
                      </button>
                    </div>
                    <ToggleSwitch
                      label="音声プレビュー"
                      checked={!isReplayAudioMuted}
                      onChange={(value) => setIsReplayAudioMuted(!value)}
                    />
                    <p className="helper-text">
                      {sinkSelectionSupported
                        ? hasAudioOutputDevices
                          ? '複数の再生デバイスがある場合はここから切り替え可能です。'
                          : '出力候補がありません。OS/ブラウザ側の設定でデバイスを確認してください。'
                        : 'このブラウザでは再生先の切り替えに対応していません（HTTPS + 対応ブラウザが必要）。'}
                    </p>
                    {audioOutputDevicesError && <p className="helper-text">{audioOutputDevicesError}</p>}
                    {outputSinkError && <p className="helper-text">{outputSinkError}</p>}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </article>
      <article className="panel-card" data-state={sections.provider ? 'open' : 'closed'}>
        <button type="button" className="panel-card__header" onClick={() => toggleSection('provider')}>
          <span>プロバイダー設定</span>
          <span className="panel-card__chevron">{sections.provider ? '▾' : '▸'}</span>
        </button>
        <div className="panel-card__body" aria-hidden={!sections.provider}>
          <div className={`mic-status ${isStreaming ? 'active' : ''}`}>
            <div className="mic-ring">
              <Icons.Mic />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {micPermission === 'granted' ? <Icons.Check /> : <Icons.Alert />}
                <strong>マイク権限: {micPermissionLabel}</strong>
              </div>
              <p className="helper-text">{micPermissionHint}</p>
              {micPermission !== 'granted' && (
                <button type="button" className="link-button" onClick={refreshMicPermission}>
                  状態を再確認
                </button>
              )}
            </div>
            <div className={`mic-meter ${isStreaming ? 'active' : ''}`}>
              <span />
              <span />
              <span />
            </div>
          </div>
          <div className="field">
            <label>言語 (Language)</label>
            <input value={lang} onChange={(event) => setLang(event.target.value)} />
          </div>
          <div className="field">
            <label>句読点の付与</label>
            <select value={punctuationPolicy} onChange={(event) => setPunctuationPolicy(event.target.value as PunctuationPolicy)}>
              {punctuationOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            {selectedProviderInfo?.id === 'deepgram' && !punctuationDisabled && (
              <p className="helper-text">Deepgramは句読点を全体ON/OFFのみサポート</p>
            )}
            {punctuationDisabled && (
              <p className="helper-text">このプロバイダは句読点ポリシーに対応していません。</p>
            )}
          </div>
        </div>
      </article>
      <article className="panel-card" data-state={sections.advanced ? 'open' : 'closed'}>
        <button type="button" className="panel-card__header" onClick={() => toggleSection('advanced')}>
          <span>詳細オプション</span>
          <span className="panel-card__chevron">{sections.advanced ? '▾' : '▸'}</span>
        </button>
        <div className="panel-card__body" aria-hidden={!sections.advanced}>
          <div className="field">
            <label>辞書 / コンテキスト (Dictionary)</label>
            <textarea
              value={dictionary}
              onChange={(event) => setDictionary(event.target.value)}
              disabled={dictionaryDisabled}
              rows={4}
              placeholder="専門用語やフレーズを改行区切りで入力..."
            />
            <p className="helper-text">
              {dictionaryDisabled
                ? 'このプロバイダでは辞書やコンテキストフレーズが利用されません。'
                : '辞書はRealtimeとBatchの両方で共有されます。'}
            </p>
          </div>
          <div className="field" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <ToggleSwitch label="途中経過を出力" checked={enableInterim} onChange={setEnableInterim} />
            <ToggleSwitch label="VAD を有効化" checked={enableVad} onChange={setEnableVad} />
            <ToggleSwitch
              label="品質低下モードを許可 (16kHz/mono未満でも続行)"
              checked={allowDegraded}
              onChange={setAllowDegraded}
            />
          </div>
          <p className="helper-text">録音/再生は画面下部のフローティングボタンから操作できます。</p>
        </div>
      </article>
    </section>
  );
});
