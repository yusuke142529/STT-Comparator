import { useEffect, useRef, useState } from 'react';

interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
}

interface RetryState {
  attempt: number;
  nextInMs: number | null;
  active: boolean;
}

export function useRetry({ maxAttempts = 3, baseDelayMs = 1000 }: RetryOptions = {}) {
  const [state, setState] = useState<RetryState>({ attempt: 0, nextInMs: null, active: false });
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const countdownRef = useRef<NodeJS.Timeout | null>(null);

  const clearTimers = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
    timerRef.current = null;
    countdownRef.current = null;
  };

  const cancel = () => {
    clearTimers();
    setState((prev) => ({ ...prev, active: false, nextInMs: null }));
  };

  const reset = () => {
    cancel();
    setState({ attempt: 0, nextInMs: null, active: false });
  };

  const schedule = (fn: () => void) => {
    clearTimers(); // ensure only one timer is active
    if (state.attempt >= maxAttempts) {
      setState((prev) => ({ ...prev, active: false, nextInMs: null }));
      return;
    }
    const nextAttempt = state.attempt + 1;
    const delay = baseDelayMs * Math.pow(2, nextAttempt - 1);
    setState({ attempt: nextAttempt, nextInMs: delay, active: true });

    let remaining = delay;
    countdownRef.current = setInterval(() => {
      remaining -= 200;
      if (remaining <= 0) {
        clearInterval(countdownRef.current!);
        setState((prev) => ({ ...prev, nextInMs: 0 }));
      } else {
        setState((prev) => ({ ...prev, nextInMs: remaining }));
      }
    }, 200);

    timerRef.current = setTimeout(() => {
      clearInterval(countdownRef.current!);
      setState((prev) => ({ ...prev, nextInMs: null }));
      fn();
    }, delay);
  };

  useEffect(() => {
    return clearTimers;
  }, []);

  return {
    ...state,
    schedule,
    reset,
    cancel,
  };
}
