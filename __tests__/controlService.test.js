const { createControlService } = require("../src/main/services/controlService");
const LRUCache = require("../src/main/utils/lruCache");

describe("controlService", () => {
  let modelService;
  let metrics;
  let responseCache;

  beforeEach(() => {
    responseCache = new LRUCache(64);
    metrics = {
      recordLLMCall: jest.fn(),
      recordCacheHit: jest.fn(),
      recordCacheMiss: jest.fn(),
      recordTiming: jest.fn()
    };

    modelService = {
      getOpenAIModel: () => "openai-model",
      getGeminiModel: () => "gemini-model",
      callOpenAIVision: jest.fn(),
      callGeminiVision: jest.fn(),
      callOpenAIChat: jest.fn(),
      callGeminiText: jest.fn()
    };
  });

  test("ROUTING: selects OpenAI when available", async () => {
    modelService.callOpenAIChat.mockResolvedValue("openai content long enough to be confident");
    const ctrl = createControlService({ modelService, metrics, responseCache, responseCacheTTL: 60000 });

    const res = await ctrl.request({ finalPrompt: "hello world", openAIEnabled: true, geminiEnabled: true });
    expect(res.usedModel).toMatch(/openai:openai-model/);
    expect(modelService.callOpenAIChat).toHaveBeenCalled();
  });

  test("RETRY: retries on transient failure and succeeds", async () => {
    let callCount = 0;
    modelService.callOpenAIChat.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) throw new Error("transient");
      return "ok after retry from openai";
    });

    const ctrl = createControlService({ modelService, metrics, responseCache, responseCacheTTL: 60000 });
    const res = await ctrl.request({ finalPrompt: "retry test", openAIEnabled: true, geminiEnabled: false });
    expect(res.response).toContain("ok after retry");
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  test("FALLBACK: primary fails, fallback provider used", async () => {
    modelService.callOpenAIChat.mockRejectedValue(new Error("openai dead"));
    modelService.callGeminiText.mockResolvedValue("gemini success content sufficient length to be confident");

    const ctrl = createControlService({ modelService, metrics, responseCache, responseCacheTTL: 60000 });
    const res = await ctrl.request({ finalPrompt: "fallback test", openAIEnabled: true, geminiEnabled: true });
    expect(res.usedModel).toMatch(/gemini:gemini-model/);
    expect(modelService.callGeminiText).toHaveBeenCalled();
  });

  test("CONFIDENCE: low-quality response triggers try of next provider", async () => {
    modelService.callOpenAIChat.mockResolvedValue("I don't know.");
    modelService.callGeminiText.mockResolvedValue("Detailed answer from gemini that is high quality and long enough.");

    const ctrl = createControlService({ modelService, metrics, responseCache, responseCacheTTL: 60000 });
    const res = await ctrl.request({ finalPrompt: "confidence test", openAIEnabled: true, geminiEnabled: true });
    // should ultimately use gemini because openai response is low-confidence
    expect(res.usedModel).toMatch(/gemini:gemini-model/);
    expect(modelService.callGeminiText).toHaveBeenCalled();
  });

  test("CACHE: repeated request returns cached result without re-calling model", async () => {
    modelService.callOpenAIChat.mockResolvedValue("cached content from openai which is a bit longer to avoid low confidence triggers");
    modelService.callGeminiText.mockResolvedValue("cached content from gemini");
    const ctrl = createControlService({ modelService, metrics, responseCache, responseCacheTTL: 60000 });

    const opt = { finalPrompt: "cache test prompt", openAIEnabled: true, geminiEnabled: true };
    const first = await ctrl.request(opt);
    expect(first.response).toBeDefined();

    expect(modelService.callOpenAIChat.mock.calls.length + modelService.callGeminiText.mock.calls.length).toBeGreaterThan(0);

    const callsBefore = {
      openai: modelService.callOpenAIChat.mock.calls.length,
      gemini: modelService.callGeminiText.mock.calls.length
    };

    const second = await ctrl.request(opt);
    expect(second.response).toBeDefined();
    // model should not be called again due to cache
    expect(modelService.callOpenAIChat.mock.calls.length).toBe(callsBefore.openai);
    expect(modelService.callGeminiText.mock.calls.length).toBe(callsBefore.gemini);
    expect(metrics.recordCacheHit).toHaveBeenCalled();
  });
});
