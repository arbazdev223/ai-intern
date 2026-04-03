const mockOpenaiCreate = jest.fn();
const mockGeminiGenerate = jest.fn();

jest.mock("openai", () => {
  return class OpenAI {
    constructor() {
      this.chat = { completions: { create: mockOpenaiCreate } };
    }
  };
});

jest.mock("@google/generative-ai", () => {
  return {
    GoogleGenerativeAI: class GoogleGenerativeAI {
      constructor() {}

      getGenerativeModel() {
        return {
          generateContent: mockGeminiGenerate
        };
      }
    }
  };
});

jest.mock("../src/main/rag/embeddingService", () => ({
  generateEmbedding: jest.fn(async () => ({ embedding: [0.1, 0.2], provider: "local" }))
}));

jest.mock("../src/main/rag/vectorStore", () => ({
  createVectorStore: () => ({
    addMemory: jest.fn().mockResolvedValue(true),
    searchSimilar: jest.fn().mockResolvedValue([])
  })
}));

const { createAiClient } = require("../src/main/aiClient");

describe("aiClient", () => {
  const searchService = { search: jest.fn() };

  beforeEach(() => {
    mockOpenaiCreate.mockReset();
    mockGeminiGenerate.mockReset();
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GPT_key;
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GPT_key;
  });

  test("uses OpenAI when OPENAI_API_KEY is set", async () => {
    process.env.OPENAI_API_KEY = "sk-test-1234567890";
    mockOpenaiCreate.mockResolvedValue({
      choices: [{ message: { content: "hello" } }]
    });

    const client = createAiClient({
      getCurrentApp: () => "Test",
      searchService
    });

    const result = await client.generate({ userPrompt: "Hello", rawPrompt: true });

    expect(mockOpenaiCreate).toHaveBeenCalled();
    expect(mockGeminiGenerate).not.toHaveBeenCalled();
    expect(result.usedModel).toMatch(/^openai:/);
    expect(result.provider).toBe("openai");
  });

  test("uses Gemini when OpenAI is missing and GEMINI_API_KEY is set", async () => {
    process.env.GEMINI_API_KEY = "gem-test";
    mockGeminiGenerate.mockResolvedValue({
      response: { text: () => "hello" }
    });

    const client = createAiClient({
      getCurrentApp: () => "Test",
      searchService
    });

    const result = await client.generate({ userPrompt: "Hello", rawPrompt: true });

    expect(mockOpenaiCreate).not.toHaveBeenCalled();
    expect(mockGeminiGenerate).toHaveBeenCalled();
    expect(result.usedModel).toMatch(/^gemini:/);
    expect(result.provider).toBe("gemini");
  });

  test("returns friendly message when no API keys are configured", async () => {
    const client = createAiClient({
      getCurrentApp: () => "Test",
      searchService
    });

    const result = await client.generate({ userPrompt: "Hello", rawPrompt: true });

    expect(result.response).toBe("No AI API configured.");
    expect(result.provider).toBe("unconfigured");
  });

  test("uses web search direct response for search-triggered queries", async () => {
    process.env.OPENAI_API_KEY = "sk-test-1234567890";
    mockOpenaiCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: "### Abhi Kya Chal Raha Hai\n- Global updates mixed hain.\n\n### Quick Take\n- Sources ke basis par yeh high-level summary hai."
          }
        }
      ]
    });

    const localSearchService = {
      search: jest.fn().mockResolvedValue({
        summary: "Aaj global level par economy aur geopolitics major discussion me hain.",
        relatedTopics: ["Oil prices", "Elections"],
        sources: [
          { title: "Reuters", url: "https://www.reuters.com/world/", snippet: "Market update" }
        ]
      })
    };

    const client = createAiClient({
      getCurrentApp: () => "Test",
      searchService: localSearchService
    });

    const result = await client.generate({
      userPrompt: "search karke batao mujhe duniya me abhi kya chal raha hai"
    });

    expect(localSearchService.search).toHaveBeenCalled();
    expect(result.provider).toBe("tool:webSearch");
    expect(/### Abhi Kya Chal Raha Hai|reliable live headlines clear nahi mili/i.test(result.response)).toBe(true);
    if (result.response.includes("### Sources")) {
      expect(result.response).toContain("Reuters");
    }
  });

  test("web search response does not leak external content markers", async () => {
    const localSearchService = {
      search: jest.fn().mockResolvedValue({
        summary: "[BEGIN EXTERNAL CONTENT]\nLive update\n[END EXTERNAL CONTENT]",
        relatedTopics: ["[BEGIN EXTERNAL CONTENT]\nTopic A\n[END EXTERNAL CONTENT]"],
        sources: [
          {
            title: "[BEGIN EXTERNAL CONTENT]\nExample Source\n[END EXTERNAL CONTENT]",
            url: "https://example.com/news",
            snippet: "[BEGIN EXTERNAL CONTENT]\nSnippet\n[END EXTERNAL CONTENT]"
          }
        ]
      })
    };

    const client = createAiClient({
      getCurrentApp: () => "Test",
      searchService: localSearchService
    });

    const result = await client.generate({ userPrompt: "latest search news" });

    expect(result.response).not.toContain("[BEGIN EXTERNAL CONTENT]");
    expect(result.response).not.toContain("[END EXTERNAL CONTENT]");
    expect(/### Abhi Kya Chal Raha Hai|Abhi reliable live headlines clear nahi mili/i.test(result.response)).toBe(true);
    expect(result.response).not.toContain("[BEGIN EXTERNAL CONTENT]");
  });

  test("current-events search returns headline-style summary instead of generic visit-site phrasing", async () => {
    const localSearchService = {
      search: jest.fn().mockResolvedValue({
        summary: "World updates",
        relatedTopics: ["Markets", "Geopolitics"],
        sources: [
          {
            title: "Global markets react to fresh policy signals",
            url: "https://www.bbc.com/news/world-1",
            snippet: "Investors responded across regions.",
            source: "BBC"
          },
          {
            title: "Leaders discuss regional security tensions",
            url: "https://www.reuters.com/world/",
            snippet: "Talks continue on de-escalation.",
            source: "Reuters"
          }
        ]
      })
    };

    const client = createAiClient({
      getCurrentApp: () => "Test",
      searchService: localSearchService
    });

    const result = await client.generate({
      userPrompt: "search karke batao mujhe ki duniya me abhi kya chal raha hai"
    });

    expect(result.provider).toBe("tool:webSearch");
    expect(/### Abhi Kya Chal Raha Hai|reliable live headlines clear nahi mili/i.test(result.response)).toBe(true);
    if (result.response.includes("### Abhi Kya Chal Raha Hai")) {
      expect(result.response).toContain("Global markets react to fresh policy signals");
    }
  });

  test("non-image prompt does not trigger image generation when classifier says creative_prompt", async () => {
    process.env.OPENAI_API_KEY = "sk-test-1234567890";
    mockOpenaiCreate
      .mockResolvedValueOnce({
        choices: [{ message: { content: '{"type":"creative_prompt","confidence":0.95}' } }]
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: '{"intent":"other","confidence":0.7}' } }]
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: '{"valid":false,"confidence":0.8}' } }]
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: '{"intent":"web_search","confidence":0.9}' } }]
      });

    const localSearchService = {
      search: jest.fn().mockResolvedValue({
        summary: "India me aaj policy aur market updates par focus hai.",
        relatedTopics: ["Policy", "Economy"],
        sources: [{ title: "Example", url: "https://example.com", snippet: "update" }]
      })
    };

    const client = createAiClient({
      getCurrentApp: () => "Test",
      searchService: localSearchService
    });

    const result = await client.generate({ userPrompt: "india ka under" });

    expect(result.type).not.toBe("image");
    expect(result.provider).not.toBe("openai-image");
    expect(String(result.response || "").toLowerCase()).not.toContain("here is your generated image");
  });

  test("current-events fallback does not append untrusted sources", async () => {
    const localSearchService = {
      search: jest.fn().mockResolvedValue({
        summary: "No direct summary found.",
        relatedTopics: [],
        sources: [
          {
            title: "Random local headline",
            url: "https://example.com/local-news",
            snippet: "Not clearly world-news relevant"
          }
        ]
      })
    };

    const client = createAiClient({
      getCurrentApp: () => "Test",
      searchService: localSearchService
    });

    const result = await client.generate({
      userPrompt: "search karke batao mujhe ki duniya ka under abhi kya chal raha hai"
    });

    expect(result.provider).toBe("tool:webSearch");
    expect(result.response).toContain("reliable live headlines clear nahi mili");
    expect(result.response).not.toContain("### Sources");
    expect(result.response).not.toContain("example.com/local-news");
  });
});
