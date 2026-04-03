// Global test setup for Jest
// Provide a basic fetch mock (tests may override) and set default timeout
if (typeof global.fetch !== "function") {
  global.fetch = jest.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  );
}

// Increase default test timeout to avoid flaky timing failures
jest.setTimeout(10000);

// Ensure tests that call jest.useFakeTimers() get legacy timers for deterministic behavior
const originalUseFakeTimers = jest.useFakeTimers.bind(jest);
jest.useFakeTimers = (timerImpl) => originalUseFakeTimers(timerImpl || "legacy");
