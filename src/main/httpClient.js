const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 300;
const MAX_BACKOFF_MS = 2000;
const RETRY_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function getFetch() {
  if (typeof fetch === "function") {
    return fetch;
  }

  throw new Error("Global fetch is not available in this runtime.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTimeoutSignal(timeoutMs, externalSignal) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error("Request timed out"));
  }, timeoutMs);

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason || new Error("Request aborted"));
    } else {
      externalSignal.addEventListener(
        "abort",
        () => {
          controller.abort(externalSignal.reason || new Error("Request aborted"));
        },
        { once: true }
      );
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timeoutId)
  };
}

function shouldRetry(error, response) {
  if (response) {
    return RETRY_STATUS_CODES.has(response.status);
  }

  if (!error) {
    return false;
  }

  const name = String(error.name || "").toLowerCase();
  const message = String(error.message || "").toLowerCase();

  if (name.includes("abort")) {
    return true;
  }

  return (
    message.includes("timeout") ||
    message.includes("networkerror") ||
    message.includes("fetch failed") ||
    message.includes("econnreset") ||
    message.includes("econnrefused")
  );
}

// Wrap fetch with a hard timeout to prevent hanging requests.
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const fetchFn = getFetch();
  const { signal, cleanup } = createTimeoutSignal(timeoutMs, options.signal);

  try {
    return await fetchFn(url, {
      ...options,
      signal
    });
  } finally {
    cleanup();
  }
}

// Retry on transient failures with exponential backoff and jitter.
async function fetchWithRetry(url, options = {}, retryOptions = {}) {
  const retries =
    Number.isFinite(retryOptions.retries) && retryOptions.retries >= 0
      ? retryOptions.retries
      : DEFAULT_RETRIES;
  const timeoutMs =
    Number.isFinite(retryOptions.timeoutMs) && retryOptions.timeoutMs > 0
      ? retryOptions.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const baseDelayMs =
    Number.isFinite(retryOptions.baseDelayMs) && retryOptions.baseDelayMs > 0
      ? retryOptions.baseDelayMs
      : DEFAULT_BACKOFF_MS;
  const label = String(retryOptions.label || "").trim();

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, options, timeoutMs);
      if (!shouldRetry(null, response) || attempt === retries) {
        return response;
      }
      if (attempt < retries) {
        console.warn(
          `[httpClient] retrying${label ? ` ${label}` : ""} after status ${response.status}`
        );
      }
    } catch (error) {
      if (!shouldRetry(error) || attempt === retries) {
        throw error;
      }
      if (attempt < retries) {
        const reason = String(error && error.name ? error.name : "error");
        console.warn(`[httpClient] retrying${label ? ` ${label}` : ""} after ${reason}`);
      }
    }

    const backoff = Math.min(MAX_BACKOFF_MS, Math.round(baseDelayMs * Math.pow(2, attempt)));
    const jitter = process.env.JEST_WORKER_ID ? 0 : Math.floor(Math.random() * 120);
    const delayMs = backoff + jitter;
    if (process.env.JEST_WORKER_ID) {
      // In Jest runs, avoid real delays to keep tests deterministic.
      continue;
    }
    await sleep(delayMs);
  }

  throw new Error("Request failed after retries.");
}

module.exports = {
  fetchWithRetry,
  fetchWithTimeout
};
