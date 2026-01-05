export type MeetingGateConfig = {
  enabled?: boolean;
  minRms?: number;
  noiseAlpha?: number;
  openFactor?: number;
  closeFactor?: number;
  hangoverMs?: number;
  assistantGuardFactor?: number;
  vad?: MeetingGateVadConfig;
};

export type MeetingGateVadConfig = {
  enabled?: boolean;
  /** 0 (lenient) .. 3 (aggressive). */
  mode?: number;
  frameMs?: number;
  minSpeechFrames?: number;
  speechRatio?: number;
};

export type MeetingGateInput = {
  captureTs?: number;
  durationMs?: number;
  assistantSpeaking?: boolean;
  sampleRateHz?: number;
};

type ResolvedMeetingGateConfig = {
  enabled: boolean;
  minRms: number;
  noiseAlpha: number;
  openFactor: number;
  closeFactor: number;
  hangoverMs: number;
  assistantGuardFactor: number;
  vad: ResolvedMeetingGateVadConfig;
};

type ResolvedMeetingGateVadConfig = {
  enabled: boolean;
  mode: number;
  frameMs: number;
  minSpeechFrames: number;
  speechRatio: number;
  snrThreshold: number;
  zcrMin: number;
  zcrMax: number;
  toneStdRatio: number;
};

export type MeetingGateDecision = {
  allow: boolean;
  opened: boolean;
  closed: boolean;
  speechDetected: boolean;
};

type MeetingGateState = {
  open: boolean;
  noiseRms: number;
  hangoverUntilMs: number;
  lastCaptureTs: number;
};

const DEFAULT_VAD: ResolvedMeetingGateVadConfig = {
  enabled: true,
  mode: 1,
  frameMs: 20,
  minSpeechFrames: 2,
  speechRatio: 0.3,
  snrThreshold: 2.5,
  zcrMin: 0.01,
  zcrMax: 0.45,
  toneStdRatio: 0.1,
};

const VAD_PRESETS: Array<Pick<
  ResolvedMeetingGateVadConfig,
  'snrThreshold' | 'zcrMin' | 'zcrMax' | 'minSpeechFrames' | 'speechRatio' | 'toneStdRatio'
>> = [
  { snrThreshold: 2.0, zcrMin: 0.005, zcrMax: 0.5, minSpeechFrames: 1, speechRatio: 0.2, toneStdRatio: 0.08 },
  { snrThreshold: 2.5, zcrMin: 0.01, zcrMax: 0.45, minSpeechFrames: 2, speechRatio: 0.3, toneStdRatio: 0.1 },
  { snrThreshold: 3.0, zcrMin: 0.015, zcrMax: 0.4, minSpeechFrames: 2, speechRatio: 0.4, toneStdRatio: 0.12 },
  { snrThreshold: 3.5, zcrMin: 0.02, zcrMax: 0.35, minSpeechFrames: 3, speechRatio: 0.5, toneStdRatio: 0.14 },
];

const DEFAULT_CONFIG: ResolvedMeetingGateConfig = {
  enabled: true,
  minRms: 0.01,
  noiseAlpha: 0.03,
  openFactor: 3.0,
  closeFactor: 1.8,
  hangoverMs: 250,
  assistantGuardFactor: 1.5,
  vad: DEFAULT_VAD,
};

const clampNumber = (value: number | undefined, min: number, max: number, fallback: number): number => {
  const safe = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, safe));
};

const clampInt = (value: number | undefined, min: number, max: number, fallback: number): number => {
  const safe = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, safe));
};

const resolveConfig = (config?: MeetingGateConfig): ResolvedMeetingGateConfig => {
  const mode = clampInt(config?.vad?.mode, 0, VAD_PRESETS.length - 1, DEFAULT_VAD.mode);
  const preset = VAD_PRESETS[mode] ?? DEFAULT_VAD;
  const vad: ResolvedMeetingGateVadConfig = {
    enabled: config?.vad?.enabled ?? DEFAULT_VAD.enabled,
    mode,
    frameMs: clampInt(config?.vad?.frameMs, 10, 30, DEFAULT_VAD.frameMs),
    minSpeechFrames: clampInt(config?.vad?.minSpeechFrames, 1, 10, preset.minSpeechFrames),
    speechRatio: clampNumber(config?.vad?.speechRatio, 0.1, 1, preset.speechRatio),
    snrThreshold: preset.snrThreshold,
    zcrMin: preset.zcrMin,
    zcrMax: preset.zcrMax,
    toneStdRatio: preset.toneStdRatio,
  };
  return {
    enabled: config?.enabled ?? DEFAULT_CONFIG.enabled,
    minRms: clampNumber(config?.minRms, 0, 1, DEFAULT_CONFIG.minRms),
    noiseAlpha: clampNumber(config?.noiseAlpha, 0, 1, DEFAULT_CONFIG.noiseAlpha),
    openFactor: clampNumber(config?.openFactor, 1, 20, DEFAULT_CONFIG.openFactor),
    closeFactor: clampNumber(config?.closeFactor, 1, 20, DEFAULT_CONFIG.closeFactor),
    hangoverMs: clampNumber(config?.hangoverMs, 0, 5000, DEFAULT_CONFIG.hangoverMs),
    assistantGuardFactor: clampNumber(
      config?.assistantGuardFactor,
      1,
      5,
      DEFAULT_CONFIG.assistantGuardFactor
    ),
    vad,
  };
};

const computeRms16le = (pcm: Buffer): number => {
  const samples = Math.floor(pcm.byteLength / 2);
  if (samples <= 0) return 0;
  const view = new Int16Array(pcm.buffer, pcm.byteOffset, samples);
  let sum = 0;
  for (let i = 0; i < view.length; i += 1) {
    const v = view[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / view.length);
};

const computeFrameStats = (
  view: Int16Array,
  start: number,
  end: number,
  toneStdRatio: number
): { rms: number; zcr: number; toneLike: boolean } => {
  const length = end - start;
  if (length <= 0) return { rms: 0, zcr: 0, toneLike: false };

  let sumSq = 0;
  let crossings = 0;
  let lastCross = -1;
  let intervalSum = 0;
  let intervalSq = 0;
  let intervalCount = 0;
  let prev = view[start] ?? 0;
  for (let i = start; i < end; i += 1) {
    const v = view[i] ?? 0;
    const normalized = v / 32768;
    sumSq += normalized * normalized;
    if (i > start) {
      if ((prev >= 0 && v < 0) || (prev < 0 && v >= 0)) {
        crossings += 1;
        if (lastCross >= 0) {
          const interval = i - lastCross;
          intervalSum += interval;
          intervalSq += interval * interval;
          intervalCount += 1;
        }
        lastCross = i;
      }
    }
    prev = v;
  }

  const rms = Math.sqrt(sumSq / length);
  const zcr = crossings / length;
  let toneLike = false;
  if (intervalCount >= 4) {
    const mean = intervalSum / intervalCount;
    const variance = Math.max(0, intervalSq / intervalCount - mean * mean);
    const std = Math.sqrt(variance);
    const ratio = std / (mean + 1e-4);
    toneLike = ratio < toneStdRatio;
  }

  return { rms, zcr, toneLike };
};

export function createMeetingAudioGate(config?: MeetingGateConfig) {
  const resolved = resolveConfig(config);
  const state: MeetingGateState = {
    open: false,
    noiseRms: 0.005,
    hangoverUntilMs: 0,
    lastCaptureTs: 0,
  };

  const reset = () => {
    state.open = false;
    state.noiseRms = 0.005;
    state.hangoverUntilMs = 0;
    state.lastCaptureTs = 0;
  };

  const resolveNow = (input?: MeetingGateInput): number => {
    if (Number.isFinite(input?.captureTs)) {
      const ts = input?.captureTs ?? 0;
      state.lastCaptureTs = ts;
      return ts;
    }
    const duration = input?.durationMs ?? 0;
    if (state.lastCaptureTs > 0 && Number.isFinite(duration)) {
      state.lastCaptureTs += duration;
      return state.lastCaptureTs;
    }
    const now = Date.now();
    state.lastCaptureTs = now;
    return now;
  };

  const shouldForward = (pcm: Buffer, input?: MeetingGateInput): MeetingGateDecision => {
    if (!resolved.enabled) {
      return { allow: true, opened: false, closed: false, speechDetected: true };
    }
    if (!pcm || pcm.byteLength < 2) {
      return { allow: false, opened: false, closed: false, speechDetected: false };
    }

    const prevOpen = state.open;
    const now = resolveNow(input);
    const guard = input?.assistantSpeaking ? resolved.assistantGuardFactor : 1;
    const sampleRate = clampNumber(input?.sampleRateHz, 8000, 48_000, 16_000);
    const speechThreshold = Math.max(
      resolved.minRms,
      state.noiseRms * (state.open ? resolved.closeFactor : resolved.openFactor)
    ) * guard;

    let speechDetected = false;

    if (resolved.vad.enabled) {
      const view = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
      const frameSamples = Math.max(1, Math.round((sampleRate * resolved.vad.frameMs) / 1000));
      let speechFrames = 0;
      let totalFrames = 0;
      let noiseRms = state.noiseRms;

      for (let offset = 0; offset < view.length; offset += frameSamples) {
        const end = Math.min(view.length, offset + frameSamples);
        if (end <= offset) break;
        totalFrames += 1;
        const stats = computeFrameStats(view, offset, end, resolved.vad.toneStdRatio);
        const dynamicThreshold = Math.max(
          resolved.minRms,
          noiseRms * (state.open ? resolved.closeFactor : resolved.openFactor)
        ) * guard;
        const snr = stats.rms / (noiseRms + 1e-4);
        const energyOk = stats.rms >= dynamicThreshold && snr >= resolved.vad.snrThreshold;
        const zcrOk = stats.zcr >= resolved.vad.zcrMin && stats.zcr <= resolved.vad.zcrMax;
        const speechFrame = energyOk && zcrOk && !stats.toneLike;
        if (speechFrame) {
          speechFrames += 1;
        } else if (stats.rms < noiseRms || !state.open) {
          noiseRms = noiseRms * (1 - resolved.noiseAlpha) + stats.rms * resolved.noiseAlpha;
        }
      }

      if (totalFrames > 0) {
        const minSpeechFrames = Math.min(resolved.vad.minSpeechFrames, totalFrames);
        const ratio = speechFrames / totalFrames;
        speechDetected = speechFrames >= minSpeechFrames && ratio >= resolved.vad.speechRatio;
      }

      state.noiseRms = noiseRms;
    } else {
      const rms = computeRms16le(pcm);
      speechDetected = rms >= speechThreshold;
      if (!state.open || rms < state.noiseRms) {
        state.noiseRms = state.noiseRms * (1 - resolved.noiseAlpha) + rms * resolved.noiseAlpha;
      }
    }

    if (!state.open) {
      if (speechDetected) {
        state.open = true;
        state.hangoverUntilMs = now + resolved.hangoverMs;
      }
    } else if (speechDetected) {
      state.hangoverUntilMs = now + resolved.hangoverMs;
    } else if (now >= state.hangoverUntilMs) {
      state.open = false;
    }

    const opened = !prevOpen && state.open;
    const closed = prevOpen && !state.open;
    return { allow: state.open, opened, closed, speechDetected };
  };

  return {
    config: resolved,
    reset,
    shouldForward,
    getState: () => ({ ...state }),
  };
}
