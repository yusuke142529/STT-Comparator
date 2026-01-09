export type VoiceState = 'listening' | 'thinking' | 'speaking';

export type VoiceInputSource = 'mic' | 'meeting';

export interface VoiceSessionMessage {
  type: 'voice_session';
  sessionId: string;
  startedAt: string;
  presetId?: string;
  mode?: 'pipeline' | 'openai_realtime';
  inputSampleRate: number;
  outputAudioSpec: { sampleRate: number; channels: number; format: string };
  sttProvider: string;
  llmProvider: string;
  ttsProvider: string;
}

export interface VoiceStateMessage {
  type: 'voice_state';
  state: VoiceState;
  ts: number;
  turnId?: string;
}

export interface VoiceUserTranscriptMessage {
  type: 'voice_user_transcript';
  isFinal: boolean;
  text: string;
  timestamp: number;
  source?: VoiceInputSource;
  speakerId?: string;
  triggered?: boolean;
}

export type UrlCitation = {
  url: string;
  title?: string;
  startIndex: number;
  endIndex: number;
};

export interface VoiceAssistantTextMessage {
  type: 'voice_assistant_text';
  turnId: string;
  text: string;
  citations?: UrlCitation[];
  isFinal: boolean;
  timestamp: number;
}

export interface VoiceAssistantAudioStartMessage {
  type: 'voice_assistant_audio_start';
  turnId: string;
  timestamp: number;
  llmMs?: number;
  ttsTtfbMs?: number;
}

export interface VoiceAssistantAudioEndMessage {
  type: 'voice_assistant_audio_end';
  turnId: string;
  timestamp: number;
  reason?: 'completed' | 'barge_in' | 'stopped' | 'error';
}

export interface VoiceMeetingWindowMessage {
  type: 'voice_meeting_window';
  state: 'opened' | 'closed';
  ts: number;
  expiresAt?: number;
  reason?: 'wake_word' | 'timeout' | 'manual' | 'cooldown';
}

export interface VoicePingMessage {
  type: 'ping';
  ts?: number;
}

export interface VoiceErrorMessage {
  type: 'error';
  message: string;
}

export type VoiceServerMessage =
  | VoiceSessionMessage
  | VoiceStateMessage
  | VoiceUserTranscriptMessage
  | VoiceAssistantTextMessage
  | VoiceAssistantAudioStartMessage
  | VoiceAssistantAudioEndMessage
  | VoiceMeetingWindowMessage
  | VoicePingMessage
  | VoiceErrorMessage;

export interface VoiceClientConfigMessage {
  type: 'config';
  pcm: true;
  clientSampleRate: number;
  enableInterim?: boolean;
  presetId?: string;
  channels?: number;
  channelSplit?: boolean;
  options?: {
    finalizeDelayMs?: number;
    meetingMode?: boolean;
    meetingRequireWakeWord?: boolean;
    meetingOutputEnabled?: boolean;
    wakeWords?: readonly string[];
    meetingOpenWindowMs?: number;
    meetingCooldownMs?: number;
    echoSuppressMs?: number;
    echoSimilarity?: number;
  };
}

export interface VoiceClientCommandMessage {
  type: 'command';
  name: 'barge_in' | 'stop_speaking' | 'reset_history';
  playedMs?: number;
}

export interface VoicePongMessage {
  type: 'pong';
  ts?: number;
}

export type VoiceClientMessage = VoiceClientConfigMessage | VoiceClientCommandMessage | VoicePongMessage;
