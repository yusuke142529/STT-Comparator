import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { useRetry } from './useRetry.js';

describe('useRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules exponential backoff and runs the callback', () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useRetry({ maxAttempts: 3, baseDelayMs: 100 }));

    act(() => result.current.schedule(fn));
    expect(result.current.attempt).toBe(1);
    expect(result.current.nextInMs).toBe(100);

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.current.nextInMs).toBeNull();
  });

  it('stops scheduling after maxAttempts and resets cleanly', () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useRetry({ maxAttempts: 2, baseDelayMs: 50 }));

    act(() => result.current.schedule(fn));
    act(() => {
      vi.advanceTimersByTime(50);
    });

    act(() => result.current.schedule(fn));
    act(() => {
      vi.advanceTimersByTime(100);
    });

    act(() => result.current.schedule(fn));
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(fn).toHaveBeenCalledTimes(2);
    expect(result.current.active).toBe(false);

    act(() => result.current.reset());
    expect(result.current.attempt).toBe(0);
    expect(result.current.nextInMs).toBeNull();
  });

  it('cancels pending retries', () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useRetry({ baseDelayMs: 80 }));

    act(() => result.current.schedule(fn));
    act(() => result.current.cancel());

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(fn).not.toHaveBeenCalled();
    expect(result.current.active).toBe(false);
  });
});
