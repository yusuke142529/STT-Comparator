export function withTimeoutSignal(
  options: { signal?: AbortSignal; timeoutMs: number }
): { signal?: AbortSignal; didTimeout: () => boolean; cleanup: () => void } {
  const { signal, timeoutMs } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { signal, didTimeout: () => false, cleanup: () => undefined };
  }

  const controller = new AbortController();
  let timedOut = false;

  const propagateAbort = () => {
    controller.abort(signal?.reason);
  };

  if (signal) {
    if (signal.aborted) {
      propagateAbort();
    } else {
      signal.addEventListener('abort', propagateAbort, { once: true });
    }
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener('abort', propagateAbort);
      }
    },
  };
}

