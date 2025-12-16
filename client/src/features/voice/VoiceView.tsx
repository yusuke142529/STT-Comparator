import { useEffect, useMemo, useState } from 'react';
import { fetchJson } from '../../utils/fetchJson';
import { useVoiceSession } from '../../hooks/useVoiceSession';

type VoiceStatusResponse = {
  available: boolean;
  missing?: string[];
  providers?: { stt: string; tts: string; llm: string };
};

export function VoiceView({ apiBase, lang }: { apiBase: string; lang: string }) {
  const session = useVoiceSession({ apiBase, lang });
  const [status, setStatus] = useState<VoiceStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

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

  const stateLabel = useMemo(() => {
    if (session.state === 'thinking') return '応答生成中…';
    if (session.state === 'speaking') return '話しています';
    return '待機中';
  }, [session.state]);

  const timingLabel = useMemo(() => {
    if (!session.lastTimings) return null;
    const llm = session.lastTimings.llmMs != null ? `${Math.round(session.lastTimings.llmMs)}ms` : '-';
    const tts = session.lastTimings.ttsTtfbMs != null ? `${Math.round(session.lastTimings.ttsTtfbMs)}ms` : '-';
    return `LLM: ${llm} / TTS(TTFB): ${tts}`;
  }, [session.lastTimings]);

  const disabled = status ? !status.available : false;

  return (
    <div className="transcript-panel">
      <div className="transcript-header">
        <div>
          <div style={{ fontWeight: 700 }}>音声会話</div>
          <div style={{ fontSize: '0.85rem', color: 'var(--c-text-muted)' }}>
            STT/TTS: ElevenLabs ・ LLM: OpenAI ・ 言語: {lang}
          </div>
        </div>
        <div className="voice-controls">
          {!session.isRunning ? (
            <button type="button" className="btn btn-primary" onClick={() => void session.start()} disabled={disabled}>
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

      {session.error && (
        <div className="banner error">
          <div>{session.error}</div>
        </div>
      )}

      <div className="transcript-body">
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
              {item.text}
            </div>
          ))}
          {session.interim && (
            <div className="voice-bubble user voice-interim">
              {session.interim}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
