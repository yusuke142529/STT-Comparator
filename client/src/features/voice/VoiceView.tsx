import { useEffect, useMemo, useState } from 'react';
import { fetchJson } from '../../utils/fetchJson';
import { useVoiceSession } from '../../hooks/useVoiceSession';
import { useAudioInputDevices } from '../../hooks/useAudioInputDevices';
import { useAudioOutputDevices } from '../../hooks/useAudioOutputDevices';
import { useMicrophonePermission } from '../../hooks/useMicrophonePermission';

type VoicePresetAvailability = {
  id: string;
  label: string;
  mode?: 'pipeline' | 'openai_realtime';
  providers: { stt: string; tts: string; llm: string };
  available: boolean;
  missingEnv: string[];
  issues: string[];
};

type VoiceStatusResponse = {
  available: boolean;
  missing?: string[];
  providers?: { stt: string; tts: string; llm: string };
  presets?: VoicePresetAvailability[];
  defaultPresetId?: string | null;
};

const PRESET_STORAGE_KEY = 'stt-comparator.voice.presetId';
const MEETING_CAPTURE_KEY = 'stt-comparator.voice.meeting.captureTabAudio';
const MEETING_OUTPUT_KEY = 'stt-comparator.voice.meeting.enableMeetOutput';
const MEETING_OUTPUT_DEVICE_KEY = 'stt-comparator.voice.meeting.outputDeviceId';
const MEETING_MONITOR_KEY = 'stt-comparator.voice.meeting.monitorAssistant';
const MEETING_MONITOR_OUTPUT_DEVICE_KEY = 'stt-comparator.voice.meeting.monitorOutputDeviceId';
const VOICE_MIC_DEVICE_KEY = 'stt-comparator.voice.mic.deviceId';
const MEETING_WAKEWORD_KEY = 'stt-comparator.voice.meeting.requireWakeWord';
const MEETING_WAKEWORDS_KEY = 'stt-comparator.voice.meeting.wakeWords';

const sinkSelectionSupported =
  typeof HTMLMediaElement !== 'undefined' &&
  typeof (HTMLMediaElement.prototype as HTMLMediaElement & { setSinkId?: (sinkId: string) => Promise<void> }).setSinkId ===
    'function';

function loadBool(key: string, fallback: boolean) {
  if (typeof window === 'undefined') return fallback;
  const raw = window.localStorage.getItem(key);
  if (raw === null) return fallback;
  return raw === '1';
}

function saveBool(key: string, value: boolean) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(key, value ? '1' : '0');
}

function loadString(key: string, fallback: string) {
  if (typeof window === 'undefined') return fallback;
  return window.localStorage.getItem(key) ?? fallback;
}

export function VoiceView({ apiBase, lang }: { apiBase: string; lang: string }) {
  const session = useVoiceSession({ apiBase, lang });
  const audioInputs = useAudioInputDevices();
  const audioOutputs = useAudioOutputDevices();
  const { status: micPermission, refresh: refreshMicPermission } = useMicrophonePermission();
  const [status, setStatus] = useState<VoiceStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [presetId, setPresetId] = useState(() => {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem(PRESET_STORAGE_KEY) ?? '';
  });
  const [captureTabAudio, setCaptureTabAudio] = useState(() => loadBool(MEETING_CAPTURE_KEY, false));
  const [enableMeetOutput, setEnableMeetOutput] = useState(() => loadBool(MEETING_OUTPUT_KEY, false));
  const [meetOutputDeviceId, setMeetOutputDeviceId] = useState(() => loadString(MEETING_OUTPUT_DEVICE_KEY, ''));
  const [monitorAssistant, setMonitorAssistant] = useState(() => loadBool(MEETING_MONITOR_KEY, true));
  const [monitorOutputDeviceId, setMonitorOutputDeviceId] = useState(() => loadString(MEETING_MONITOR_OUTPUT_DEVICE_KEY, ''));
  const [micDeviceId, setMicDeviceId] = useState(() => loadString(VOICE_MIC_DEVICE_KEY, ''));
  const [meetingRequireWakeWord, setMeetingRequireWakeWord] = useState(() => loadBool(MEETING_WAKEWORD_KEY, true));
  const [wakeWords, setWakeWords] = useState(() => loadString(MEETING_WAKEWORDS_KEY, 'アシスタント, assistant, AI'));

  useEffect(() => {
    const run = async () => {
      try {
        const data = await fetchJson<VoiceStatusResponse>(`${apiBase}/api/voice/status`);
        setStatus(data);
        setStatusError(null);
      } catch (err) {
        setStatus(null);
        setStatusError((err as Error).message);
      }
    };
    void run();
  }, [apiBase]);

  useEffect(() => {
    if (!status?.presets?.length) return;
    const isValid = presetId && status.presets.some((p) => p.id === presetId);
    const next = isValid ? presetId : status.defaultPresetId ?? status.presets[0]?.id ?? '';
    if (next && next !== presetId) {
      setPresetId(next);
    }
  }, [presetId, status]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!presetId) return;
    window.localStorage.setItem(PRESET_STORAGE_KEY, presetId);
  }, [presetId]);

  useEffect(() => saveBool(MEETING_CAPTURE_KEY, captureTabAudio), [captureTabAudio]);
  useEffect(() => saveBool(MEETING_OUTPUT_KEY, enableMeetOutput), [enableMeetOutput]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(MEETING_OUTPUT_DEVICE_KEY, meetOutputDeviceId);
  }, [meetOutputDeviceId]);
  useEffect(() => saveBool(MEETING_MONITOR_KEY, monitorAssistant), [monitorAssistant]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(MEETING_MONITOR_OUTPUT_DEVICE_KEY, monitorOutputDeviceId);
  }, [monitorOutputDeviceId]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(VOICE_MIC_DEVICE_KEY, micDeviceId);
  }, [micDeviceId]);
  useEffect(() => saveBool(MEETING_WAKEWORD_KEY, meetingRequireWakeWord), [meetingRequireWakeWord]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(MEETING_WAKEWORDS_KEY, wakeWords);
  }, [wakeWords]);

  useEffect(() => {
    setMicDeviceId((current) => {
      if (current && audioInputs.devices.some((device) => device.deviceId === current)) return current;
      return audioInputs.devices[0]?.deviceId ?? '';
    });
  }, [audioInputs.devices]);

  const selectedPreset = useMemo(() => {
    if (!status?.presets?.length) return null;
    return status.presets.find((p) => p.id === presetId) ?? null;
  }, [presetId, status]);

  const stateLabel = useMemo(() => {
    if (session.isRunning && !session.isReady) return '接続準備中…';
    if (session.state === 'thinking') return '応答生成中…';
    if (session.state === 'speaking') return '話しています';
    return '待機中';
  }, [session.isReady, session.isRunning, session.state]);

  const timingLabel = useMemo(() => {
    if (!session.lastTimings) return null;
    const llm = session.lastTimings.llmMs != null ? `${Math.round(session.lastTimings.llmMs)}ms` : '-';
    const tts = session.lastTimings.ttsTtfbMs != null ? `${Math.round(session.lastTimings.ttsTtfbMs)}ms` : '-';
    return `LLM: ${llm} / TTS(TTFB): ${tts}`;
  }, [session.lastTimings]);

  const micLevel = useMemo(() => Math.min(1, session.micRms * 3), [session.micRms]);
  const micLevelPct = Math.round(micLevel * 100);
  const micTooLow = session.isRunning && session.isReady && session.micRms < 0.015;

  const disabled = status ? !(selectedPreset?.available ?? status.available) : false;
  const meetingCaptureDisabled = selectedPreset?.mode === 'openai_realtime';
  const effectiveCaptureTabAudio = captureTabAudio && !meetingCaptureDisabled;
  const meetingAudioUngated = effectiveCaptureTabAudio && !meetingRequireWakeWord;
  const meetingCaptureHelper = meetingCaptureDisabled
    ? 'OpenAI Realtime プリセットでは Meet タブ音声取り込みを利用できません（pipeline プリセット推奨）'
    : '開始時に「Google Meet のタブ（meet.google.com）」を選び、「タブの音声を共有」をONにしてください（このアプリのタブではありません）';
  const meetOutputDisabled = !sinkSelectionSupported;
  const meetOutputHelper = meetOutputDisabled
    ? 'このブラウザは出力デバイス固定(setSinkId)に未対応です（Chrome/Edge 推奨）'
    : 'Meet 側でマイク入力を仮想デバイス（例: BlackHole）に変更してください';
  const monitorOutputDisabled = !sinkSelectionSupported;

  const micPermissionLabel = useMemo(() => {
    switch (micPermission) {
      case 'granted':
        return '許可済み';
      case 'prompt':
        return '許可待ち';
      case 'denied':
        return '拒否';
      default:
        return '不明';
    }
  }, [micPermission]);

  const micPermissionHint = useMemo(() => {
    switch (micPermission) {
      case 'granted':
        return 'マイク権限は付与されています。';
      case 'prompt':
        return '権限ダイアログが表示されていない場合は再読み込みして許可してください。';
      case 'denied':
        return 'ブラウザ設定でマイクを許可してください。';
      default:
        return 'マイク権限の状態を確認中です。';
    }
  }, [micPermission]);

  useEffect(() => {
    if (meetOutputDisabled && enableMeetOutput) {
      setEnableMeetOutput(false);
    }
  }, [enableMeetOutput, meetOutputDisabled]);

  const parsedWakeWords = useMemo(() => {
    return wakeWords
      .split(',')
      .map((w) => w.trim())
      .filter(Boolean)
      .slice(0, 20);
  }, [wakeWords]);

  const providerLabel = useMemo(() => {
    if (selectedPreset?.mode === 'openai_realtime') {
      return 'Agent: OpenAI Realtime API';
    }
    if (selectedPreset?.providers) {
      return `STT: ${selectedPreset.providers.stt} ・ TTS: ${selectedPreset.providers.tts} ・ LLM: ${selectedPreset.providers.llm}`;
    }
    if (status?.providers) {
      return `STT: ${status.providers.stt} ・ TTS: ${status.providers.tts} ・ LLM: ${status.providers.llm}`;
    }
    return 'STT/TTS: ElevenLabs ・ LLM: OpenAI';
  }, [selectedPreset, status]);

  return (
    <div className="transcript-panel">
      <div className="transcript-header">
        <div>
          <div style={{ fontWeight: 700 }}>音声会話</div>
          <div style={{ fontSize: '0.85rem', color: 'var(--c-text-muted)' }}>
            {providerLabel} ・ 言語: {lang}
          </div>
        </div>
        <div className="voice-controls">
          {status?.presets?.length ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85rem' }}>
              <span style={{ color: 'var(--c-text-muted)' }}>プリセット</span>
              <select
                value={presetId}
                onChange={(e) => setPresetId(e.target.value)}
                disabled={session.isRunning}
                style={{ maxWidth: 220 }}
              >
                {status.presets.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.available}>
                    {p.label}
                    {!p.available ? ' (unavailable)' : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {!session.isRunning ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                if (meetingAudioUngated) {
                  const ok = typeof window === 'undefined' || window.confirm(
                    'Meet タブ音声の取り込みがONで、wake word 必須がOFFです。\n会議タブの音声（ノイズ/通知音/共有対象の取り違えを含む）がユーザー発話として扱われ、誤反応しやすくなります。\n続行しますか？'
                  );
                  if (!ok) return;
                }
                void session.start({
                  presetId: presetId || undefined,
                  micDeviceId: micDeviceId || undefined,
                  meeting: {
                    presetMode: (selectedPreset?.mode as 'pipeline' | 'openai_realtime' | undefined) ?? 'pipeline',
                    captureTabAudio: effectiveCaptureTabAudio,
                    enableMeetOutput: enableMeetOutput && !meetOutputDisabled,
                    meetOutputDeviceId: meetOutputDeviceId || undefined,
                    monitorAssistant,
                    monitorOutputDeviceId: monitorOutputDeviceId || undefined,
                    meetingRequireWakeWord,
                    wakeWords: parsedWakeWords,
                  },
                });
              }}
              disabled={disabled || (enableMeetOutput && !meetOutputDisabled && !meetOutputDeviceId)}
            >
              開始
            </button>
          ) : (
            <button type="button" className="btn btn-secondary" onClick={() => void session.stop()}>
              停止
            </button>
          )}
          <button type="button" className="btn btn-secondary" onClick={session.stopSpeaking} disabled={!session.isRunning}>
            返答停止
          </button>
          <button type="button" className="btn btn-secondary" onClick={session.resetHistory} disabled={!session.isRunning}>
            履歴リセット
          </button>
        </div>
      </div>

      {statusError && (
        <div className="banner warning">
          <div>voice status: {statusError}</div>
        </div>
      )}

      {status && !status.available && (
        <div className="banner warning">
          <div>
            音声会話が利用できません: {status.missing?.join(', ') || '設定を確認してください'}
          </div>
        </div>
      )}

      {status?.available && selectedPreset && !selectedPreset.available && (
        <div className="banner warning">
          <div>
            このプリセットは利用できません: {[...selectedPreset.missingEnv, ...selectedPreset.issues].join(', ') || '設定を確認してください'}
          </div>
        </div>
      )}

      {session.error && (
        <div className="banner error">
          <div>{session.error}</div>
        </div>
      )}

      {session.warning && !session.error && (
        <div className="banner warning">
          <div>{session.warning}</div>
        </div>
      )}
      {meetingAudioUngated && !session.isRunning && (
        <div className="banner warning">
          <div>
            注意: 「Meet タブ音声を取り込む」がONで「会議音声は呼びかけ（wake word）必須」がOFFです。会議タブの音がユーザー発話として扱われ、誤反応しやすくなります。
          </div>
        </div>
      )}

      <div className="transcript-body">
        <div className="voice-meeting-settings" style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.9rem' }}>
              <span>マイク入力</span>
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <select
                value={micDeviceId}
                onChange={(e) => setMicDeviceId(e.target.value)}
                disabled={session.isRunning || audioInputs.loading || !audioInputs.hasDevices}
                style={{ minWidth: 240 }}
              >
                <option value="" disabled>
                  {audioInputs.hasDevices ? 'マイクを選択してください' : 'マイクがありません'}
                </option>
                {audioInputs.devices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={session.isRunning || audioInputs.loading}
                onClick={() => void audioInputs.refresh()}
              >
                更新
              </button>
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--c-text-muted)' }}>
              マイク権限: {micPermissionLabel}
              {micPermission !== 'granted' && (
                <>
                  {' '}
                  <button type="button" className="link-button" onClick={() => void refreshMicPermission()}>
                    状態を再確認
                  </button>
                </>
              )}
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--c-text-muted)' }}>{micPermissionHint}</div>
            {audioInputs.error && (
              <div style={{ fontSize: '0.8rem', color: 'var(--c-text-muted)' }}>{audioInputs.error}</div>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.9rem' }}>
              <input
                type="checkbox"
                checked={captureTabAudio}
                onChange={(e) => setCaptureTabAudio(e.target.checked)}
                disabled={session.isRunning || meetingCaptureDisabled}
              />
              <span>Meet タブ音声を取り込む（他参加者の発話）</span>
            </label>
            {captureTabAudio && (
              <div style={{ fontSize: '0.8rem', color: 'var(--c-text-muted)' }}>{meetingCaptureHelper}</div>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.9rem' }}>
              <input
                type="checkbox"
                checked={enableMeetOutput}
                onChange={(e) => setEnableMeetOutput(e.target.checked)}
                disabled={session.isRunning || meetOutputDisabled}
              />
              <span>Meet に自分＋AI の音声を送る（仮想デバイス出力）</span>
            </label>
            {enableMeetOutput && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <select
                  value={meetOutputDeviceId}
                  onChange={(e) => setMeetOutputDeviceId(e.target.value)}
                  disabled={session.isRunning || audioOutputs.loading || meetOutputDisabled}
                  style={{ minWidth: 240 }}
                >
                  <option value="">出力デバイスを選択（例: BlackHole）</option>
                  {audioOutputs.devices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={session.isRunning || audioOutputs.selecting}
                  onClick={() => void audioOutputs.requestSelectAudioOutput()}
                >
                  デバイス許可
                </button>
                {audioOutputs.error && (
                  <span style={{ fontSize: '0.8rem', color: 'var(--c-text-muted)' }}>{audioOutputs.error}</span>
                )}
              </div>
            )}
            {enableMeetOutput && (
              <div style={{ fontSize: '0.8rem', color: 'var(--c-text-muted)' }}>{meetOutputHelper}</div>
            )}
          </div>

          {captureTabAudio && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.9rem' }}>
                <input
                  type="checkbox"
                  checked={meetingRequireWakeWord}
                  onChange={(e) => setMeetingRequireWakeWord(e.target.checked)}
                  disabled={session.isRunning}
                />
                <span>会議音声は呼びかけ（wake word）必須</span>
              </label>
              {meetingRequireWakeWord && (
                <label style={{ display: 'grid', gap: 6, fontSize: '0.85rem' }}>
                  <span style={{ color: 'var(--c-text-muted)' }}>wake words（カンマ区切り）</span>
                  <input
                    type="text"
                    value={wakeWords}
                    onChange={(e) => setWakeWords(e.target.value)}
                    disabled={session.isRunning}
                    placeholder="アシスタント, assistant, AI"
                  />
                </label>
              )}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.9rem' }}>
              <input
                type="checkbox"
                checked={monitorAssistant}
                onChange={(e) => setMonitorAssistant(e.target.checked)}
                disabled={session.isRunning}
              />
              <span>アシスタント音声をローカルでも再生（モニタ）</span>
            </label>
            {monitorAssistant && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <select
                  value={monitorOutputDeviceId}
                  onChange={(e) => setMonitorOutputDeviceId(e.target.value)}
                  disabled={session.isRunning || audioOutputs.loading || monitorOutputDisabled}
                  style={{ minWidth: 240 }}
                >
                  <option value="">システム既定 (ブラウザ/OS)</option>
                  {audioOutputs.devices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={session.isRunning || audioOutputs.selecting}
                  onClick={() => void audioOutputs.requestSelectAudioOutput()}
                >
                  デバイス許可
                </button>
                {audioOutputs.error && (
                  <span style={{ fontSize: '0.8rem', color: 'var(--c-text-muted)' }}>{audioOutputs.error}</span>
                )}
              </div>
            )}
            {monitorAssistant && monitorOutputDisabled && (
              <div style={{ fontSize: '0.8rem', color: 'var(--c-text-muted)' }}>
                このブラウザは出力デバイス固定(setSinkId)に未対応です。OS のサウンド設定で既定出力を切り替えてください。
              </div>
            )}
          </div>
        </div>

        <div className={`mic-status ${session.isRunning ? 'active' : ''}`}>
          <div className={`mic-ring ${session.isRunning ? 'active' : ''}`} />
          <div>
            <div style={{ fontWeight: 700 }}>{stateLabel}</div>
            <div style={{ fontSize: '0.85rem', color: 'var(--c-text-muted)' }}>
              {session.sessionId ? `session: ${session.sessionId}` : 'session: -'}
            </div>
            {timingLabel && (
              <div style={{ fontSize: '0.8rem', color: 'var(--c-text-muted)' }}>
                {timingLabel}
              </div>
            )}
            <div className="voice-input-meter">
              <div className="voice-input-bar">
                <span style={{ width: `${session.isRunning ? micLevelPct : 0}%` }} />
              </div>
              <div className="voice-input-label">{session.isRunning ? `${micLevelPct}%` : '-'}</div>
            </div>
            {micTooLow && (
              <div style={{ fontSize: '0.8rem', color: 'var(--c-warning)' }}>
                マイク音量が小さく、検知されにくい可能性があります。
              </div>
            )}
            {!session.isReady && session.isRunning && (
              <div style={{ fontSize: '0.8rem', color: 'var(--c-text-muted)' }}>
                準備完了後に話し始めると安定します。
              </div>
            )}
            <div style={{ fontSize: '0.8rem', color: 'var(--c-text-muted)' }}>
              割り込み: 話しかけると返答が止まります（ヘッドホン推奨）
            </div>
          </div>
        </div>

        <div className="voice-chat">
          {session.messages.length === 0 && !session.interim && (
            <div className="transcript-empty">マイクを開始して話しかけてください。</div>
          )}
          {session.messages.map((item) => (
            <div key={item.id} className={`voice-bubble ${item.role === 'user' ? 'user' : 'assistant'}`}>
              {item.role === 'user' && item.source === 'meeting' ? (
                <span>
                  <span style={{ color: 'var(--c-text-muted)', marginRight: 6 }}>
                    （会議{item.speakerId ? `:${item.speakerId}` : ''}）
                  </span>
                  {item.text}
                </span>
              ) : (
                item.text
              )}
            </div>
          ))}
          {session.interim && (
            <div className="voice-bubble user voice-interim">
              {session.interim.source === 'meeting' ? (
                <span>
                  <span style={{ color: 'var(--c-text-muted)', marginRight: 6 }}>
                    （会議{session.interim.speakerId ? `:${session.interim.speakerId}` : ''}）
                  </span>
                  {session.interim.text}
                </span>
              ) : (
                session.interim.text
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
