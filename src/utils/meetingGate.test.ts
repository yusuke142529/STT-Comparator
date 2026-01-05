import { describe, expect, it } from 'vitest';
import { createMeetingAudioGate } from './meetingGate.js';

const buildPcm = (samples: number, amplitude: number) => {
  const clamped = Math.max(-1, Math.min(1, amplitude));
  const value = Math.round(clamped * 32767);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    buf.writeInt16LE(value, i * 2);
  }
  return buf;
};

const buildSine = (samples: number, frequency: number, sampleRate: number, amplitude: number) => {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const t = i / sampleRate;
    const v = Math.sin(2 * Math.PI * frequency * t) * amplitude;
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2);
  }
  return buf;
};

const buildDualTone = (
  samples: number,
  frequencyA: number,
  frequencyB: number,
  sampleRate: number,
  amplitude: number
) => {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const t = i / sampleRate;
    const v =
      (Math.sin(2 * Math.PI * frequencyA * t) + Math.sin(2 * Math.PI * frequencyB * t)) * 0.5 * amplitude;
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2);
  }
  return buf;
};

describe('createMeetingAudioGate', () => {
  it('opens on speech and closes after hangover', () => {
    const gate = createMeetingAudioGate({
      minRms: 0.02,
      openFactor: 1,
      closeFactor: 1,
      noiseAlpha: 0,
      hangoverMs: 100,
      assistantGuardFactor: 1,
      vad: { enabled: false },
    });

    const quiet = buildPcm(160, 0.01);
    const loud = buildPcm(160, 0.03);
    const tail = buildPcm(160, 0.005);

    expect(gate.shouldForward(quiet, { captureTs: 1000 }).allow).toBe(false);
    expect(gate.shouldForward(loud, { captureTs: 1050 }).allow).toBe(true);
    expect(gate.shouldForward(tail, { captureTs: 1080 }).allow).toBe(true);
    expect(gate.shouldForward(tail, { captureTs: 1201 }).allow).toBe(false);
  });

  it('raises thresholds while assistant is speaking', () => {
    const gate = createMeetingAudioGate({
      minRms: 0.02,
      openFactor: 1,
      closeFactor: 1,
      noiseAlpha: 0,
      hangoverMs: 0,
      assistantGuardFactor: 2,
      vad: { enabled: false },
    });

    const speech = buildPcm(160, 0.03);
    expect(gate.shouldForward(speech, { captureTs: 2000, assistantSpeaking: false }).allow).toBe(true);

    gate.reset();
    expect(gate.shouldForward(speech, { captureTs: 2000, assistantSpeaking: true }).allow).toBe(false);
  });

  it('bypasses gating when disabled', () => {
    const gate = createMeetingAudioGate({ enabled: false });
    const noise = buildPcm(160, 0.001);
    expect(gate.shouldForward(noise, { captureTs: 3000 }).allow).toBe(true);
  });

  it('suppresses stable tones in VAD mode', () => {
    const sampleRate = 16_000;
    const samples = Math.round(sampleRate * 0.2);
    const gate = createMeetingAudioGate({
      minRms: 0.01,
      openFactor: 2,
      closeFactor: 1.5,
      noiseAlpha: 0,
    });
    const tone = buildSine(samples, 1000, sampleRate, 0.05);
    const decision = gate.shouldForward(tone, { captureTs: 4000, sampleRateHz: sampleRate });
    expect(decision.allow).toBe(false);
    expect(decision.speechDetected).toBe(false);
  });

  it('detects non-tonal speech-like frames', () => {
    const sampleRate = 16_000;
    const samples = Math.round(sampleRate * 0.2);
    const gate = createMeetingAudioGate({
      minRms: 0.01,
      openFactor: 2,
      closeFactor: 1.5,
      noiseAlpha: 0,
      vad: { mode: 0 },
    });
    const speechLike = buildDualTone(samples, 300, 900, sampleRate, 0.06);
    const decision = gate.shouldForward(speechLike, { captureTs: 5000, sampleRateHz: sampleRate });
    expect(decision.allow).toBe(true);
    expect(decision.speechDetected).toBe(true);
  });
});
