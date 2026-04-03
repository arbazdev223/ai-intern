const { fetchWithRetry, fetchWithTimeout } = require("../src/main/httpClient");

describe("httpClient", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.resetAllMocks();
    global.fetch = originalFetch;
  });

  test("fetchWithTimeout aborts long requests", async () => {
    global.fetch = jest.fn((_url, options) => {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          reject(options.signal.reason || new Error("aborted"));
        });
      });
    });

    const promise = fetchWithTimeout("http://example.com", {}, 10);
    jest.advanceTimersByTime(20);
    await expect(promise).rejects.toThrow("timed out");
  });

  test("fetchWithRetry retries and eventually succeeds", async () => {
    const responses = [
      { ok: false, status: 500 },
      { ok: true, status: 200 }
    ];
    global.fetch = jest.fn(() => Promise.resolve(responses.shift()));

    const promise = fetchWithRetry("http://example.com", {}, { retries: 1, baseDelayMs: 0 });
    jest.runAllTimers();
    const response = await promise;

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(response.ok).toBe(true);
  });

  test("fetchWithRetry throws after max retries on network error", async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error("networkerror")));

    const promise = fetchWithRetry("http://example.com", {}, { retries: 1, baseDelayMs: 0 });
    jest.runAllTimers();
    await expect(promise).rejects.toThrow("networkerror");
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
