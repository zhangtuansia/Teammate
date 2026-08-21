export interface TrailingRefreshScheduler {
  cancel: () => void;
  runNow: () => Promise<void>;
  schedule: () => void;
}

export function createTrailingRefreshScheduler(
  run: () => void | Promise<void>,
  delayMs: number,
): TrailingRefreshScheduler {
  let cancelled = false;
  let pending = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const arm = () => {
    if (cancelled) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delayMs);
  };

  const flush = async () => {
    if (cancelled || running || !pending) return;
    running = true;
    pending = false;
    try {
      await run();
    } finally {
      running = false;
      if (pending && !cancelled && timer === null) arm();
    }
  };

  return {
    cancel() {
      cancelled = true;
      pending = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    async runNow() {
      if (cancelled) return;
      pending = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      await flush();
    },
    schedule() {
      if (cancelled) return;
      pending = true;
      arm();
    },
  };
}
