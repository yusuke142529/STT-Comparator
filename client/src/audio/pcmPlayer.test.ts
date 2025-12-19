import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_OUTPUT_SAMPLE_RATE, PcmPlayer } from './pcmPlayer';

class FakeAudioContext {
  currentTime = 0;
  destination = {};

  constructor(_opts?: AudioContextOptions) {
    // no-op
  }

  createGain() {
    return { gain: { value: 0 }, connect: vi.fn() } as unknown as GainNode;
  }

  createMediaStreamDestination() {
    return { stream: {} } as MediaStreamAudioDestinationNode;
  }

  createMediaStreamSource(_stream: MediaStream) {
    return { connect: vi.fn(), disconnect: vi.fn() } as unknown as MediaStreamAudioSourceNode;
  }

  close() {
    return Promise.resolve();
  }
}

describe('PcmPlayer.setMeetOutput', () => {
  const originalAudioContext = globalThis.AudioContext;
  const originalPlay = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'play');
  const originalPause = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'pause');
  const originalSetSinkId = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'setSinkId');

  beforeEach(() => {
    (globalThis as { AudioContext: typeof AudioContext }).AudioContext = FakeAudioContext as unknown as typeof AudioContext;
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', { value: vi.fn(), configurable: true });
  });

  afterEach(() => {
    if (originalPlay) {
      Object.defineProperty(HTMLMediaElement.prototype, 'play', originalPlay);
    } else {
      delete (HTMLMediaElement.prototype as { play?: unknown }).play;
    }

    if (originalPause) {
      Object.defineProperty(HTMLMediaElement.prototype, 'pause', originalPause);
    } else {
      delete (HTMLMediaElement.prototype as { pause?: unknown }).pause;
    }

    if (originalSetSinkId) {
      Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', originalSetSinkId);
    } else {
      delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;
    }

    if (originalAudioContext) {
      (globalThis as { AudioContext: typeof AudioContext }).AudioContext = originalAudioContext;
    } else {
      delete (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    }

    vi.restoreAllMocks();
  });

  it('throws when setSinkId is unavailable', async () => {
    const player = new PcmPlayer();
    player.ensure(DEFAULT_OUTPUT_SAMPLE_RATE);

    await expect(player.setMeetOutput(true, 'device-1')).rejects.toThrow(/setSinkId/);
    await player.close();
  });

  it('throws when playback fails even if setSinkId succeeds', async () => {
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', { value: setSinkId, configurable: true });
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      value: vi.fn().mockRejectedValue(new Error('nope')),
      configurable: true,
    });

    const player = new PcmPlayer();
    player.ensure(DEFAULT_OUTPUT_SAMPLE_RATE);

    await expect(player.setMeetOutput(true, 'device-1')).rejects.toThrow(/Meet 出力/);
    expect(setSinkId).toHaveBeenCalledWith('device-1');
    await player.close();
  });

  it('starts meet output when setSinkId and play succeed', async () => {
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', { value: setSinkId, configurable: true });
    const playMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLMediaElement.prototype, 'play', { value: playMock, configurable: true });

    const player = new PcmPlayer();
    player.ensure(DEFAULT_OUTPUT_SAMPLE_RATE);

    await expect(player.setMeetOutput(true, 'device-1')).resolves.toBeUndefined();
    expect(setSinkId).toHaveBeenCalledWith('device-1');
    expect(playMock).toHaveBeenCalled();
    await player.close();
  });

  it('mutes mic->meet mix while the assistant is speaking', async () => {
    const player = new PcmPlayer();
    player.ensure(DEFAULT_OUTPUT_SAMPLE_RATE);

    const micMeetGain = (player as unknown as { micMeetGain?: { gain: { value: number } } }).micMeetGain;
    expect(micMeetGain?.gain.value).toBe(1);

    player.setMeetMicMuted(true);
    expect(micMeetGain?.gain.value).toBe(0);

    player.setMeetMicMuted(false);
    expect(micMeetGain?.gain.value).toBe(1);

    await player.close();
  });
});
