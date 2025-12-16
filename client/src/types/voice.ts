export type VoiceState = 'listening' | 'thinking' | 'speaking';

export interface VoiceSessionMessage {
  type: 'voice_session';
  sessionId: string;
  startedAt: string;
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
}

export interface VoiceAssistantTextMessage {
  type: 'voice_assistant_text';
  turnId: string;
  text: string;
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
  | VoicePingMessage
  | VoiceErrorMessage;

export interface VoiceClientConfigMessage {
  type: 'config';
  pcm: true;
  clientSampleRate: number;
  enableInterim?: boolean;
  options?: {
    finalizeDelayMs?: number;
  };
}

export interface VoiceClientCommandMessage {
  type: 'command';
  name: 'barge_in' | 'stop_speaking' | 'reset_history';
}

export interface VoicePongMessage {
  type: 'pong';
  ts?: number;
}

export type VoiceClientMessage = VoiceClientConfigMessage | VoiceClientCommandMessage | VoicePongMessage;
