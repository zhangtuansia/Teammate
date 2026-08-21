export class RequestDeadlineError extends Error {
  constructor(message = "Request timed out") {
    super(message);
    this.name = "RequestDeadlineError";
  }
}

export function isNetworkRequestError(error: unknown) {
  if (error instanceof TypeError) return true;
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AuthRetryableFetchError" ||
    /(?:failed to fetch|fetch failed|network request failed)/i.test(error.message)
  );
}

export async function withRequestDeadline<T>(
  request: PromiseLike<T>,
  timeoutMs: number,
  onTimeout?: () => void,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      onTimeout?.();
      reject(new RequestDeadlineError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve(request), deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
