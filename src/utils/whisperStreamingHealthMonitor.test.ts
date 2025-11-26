import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./whisperStreamingHealth.js', () => ({
  checkWhisperStreamingHealth: vi.fn(),
  pollWhisperStreamingReadiness: vi.fn(),
  normalizeReason: vi.fn((reason: string | undefined, fallback: string) => reason?.trim() ?? fallback),
}));

import { checkWhisperStreamingHealth, pollWhisperStreamingReadiness } from './whisperStreamingHealth.js';
import { WhisperStreamingHealthMonitor } from './whisperStreamingHealthMonitor.js';

const mockCheck = checkWhisperStreamingHealth as unknown as ReturnType<typeof vi.fn>;
const mockPoll = pollWhisperStreamingReadiness as unknown as ReturnType<typeof vi.fn>;

describe('WhisperStreamingHealthMonitor', () => {
  beforeEach(() => {
    mockCheck.mockReset();
    mockPoll.mockReset();
  });

  it('marks provider available when both readiness and websocket succeed', async () => {
    mockPoll.mockResolvedValue({ available: true });
    mockCheck.mockResolvedValue({ available: true });

    const monitor = new WhisperStreamingHealthMonitor(100);
    await monitor.forceCheck();
    const snapshot = monitor.getSnapshot();

    expect(snapshot.available).toBe(true);
    expect(snapshot.reason).toBeUndefined();
  });

  it('exposes websocket failure reason when ready endpoint is healthy', async () => {
    mockPoll.mockResolvedValue({ available: true });
    mockCheck.mockResolvedValue({ available: false, reason: 'ws down' });

    const monitor = new WhisperStreamingHealthMonitor(100);
    await monitor.forceCheck();
    const snapshot = monitor.getSnapshot();

    expect(snapshot.available).toBe(false);
    expect(snapshot.reason).toBe('ws down');
  });

  it('exposes ready endpoint failure reason when readiness fails', async () => {
    mockPoll.mockResolvedValue({ available: false, reason: 'health check timed out' });

    const monitor = new WhisperStreamingHealthMonitor(100);
    await monitor.forceCheck();
    const snapshot = monitor.getSnapshot();

    expect(snapshot.available).toBe(false);
    expect(snapshot.reason).toBe('health check timed out');
  });
});
