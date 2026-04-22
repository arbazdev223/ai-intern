const OpenAI = require("openai");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { getEnv } = require("../config/env");

function isLikelyOpenAIKey(value) {
  const trimmed = String(value || "").trim();
  return trimmed.startsWith("sk-") && trimmed.length >= 16;
}

function getOpenAIKey() {
  const env = getEnv();
  const envKey = String(env.OPENAI_API_KEY || "").trim();
  if (!envKey || !isLikelyOpenAIKey(envKey)) {
    return "";
  }
  return envKey;
}

function getGeminiKey() {
  const env = getEnv();
  return String(env.GEMINI_API_KEY || "").trim();
}

function getOpenAIModel() {
  const env = getEnv();
  return String(env.OPENAI_MODEL || "gpt-4o-mini").trim();
}

function getOpenAIResearchModel() {
  const env = getEnv();
  return String(env.OPENAI_RESEARCH_MODEL || env.OPENAI_MODEL || "gpt-4.1").trim();
}

function getGeminiModel() {
  const env = getEnv();
  return String(env.GEMINI_MODEL || "gemini-1.5-flash").trim();
}

function createModelService() {
  let openAIClient = null;
  let geminiClient = null;

  function getOpenAIClient() {
    if (openAIClient) return openAIClient;
    const key = getOpenAIKey();
    if (!key) return null;
    openAIClient = new OpenAI({ apiKey: key });
    return openAIClient;
  }

  function getGeminiClient() {
    if (geminiClient) return geminiClient;
    const key = getGeminiKey();
    if (!key) return null;
    geminiClient = new GoogleGenerativeAI(key);
    return geminiClient;
  }

  async function callOpenAIChat({ model, messages, temperature = 0.2 }) {
    const client = getOpenAIClient();
    if (!client) throw new Error("OPENAI_API_KEY is missing");
    const response = await client.chat.completions.create({ model, messages, temperature });
    const content =
      response && response.choices && response.choices[0] && response.choices[0].message
        ? response.choices[0].message.content
        : "";
    return typeof content === "string" ? content : "";
  }

  async function callOpenAIVision({ model, promptText, screenshotBase64 }) {
    const client = getOpenAIClient();
    if (!client) throw new Error("OPENAI_API_KEY is missing");
    const imageUrl = screenshotBase64.startsWith("data:") ? screenshotBase64 : `data:image/png;base64,${screenshotBase64}`;
    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: promptText }, { type: "image_url", image_url: { url: imageUrl } }]
        }
      ],
      temperature: 0.2
    });
    const content =
      response && response.choices && response.choices[0] && response.choices[0].message
        ? response.choices[0].message.content
        : "";
    return typeof content === "string" ? content : "";
  }

  async function callGeminiText(promptText) {
    const client = getGeminiClient();
    if (!client) throw new Error("GEMINI_API_KEY is missing");
    const model = getGeminiModel();
    const modelClient = client.getGenerativeModel({ model });
    const result = await modelClient.generateContent(promptText);
    return result && result.response ? result.response.text() : "";
  }

  async function callGeminiVision(promptText, screenshotBase64) {
    const client = getGeminiClient();
    if (!client) throw new Error("GEMINI_API_KEY is missing");
    const model = getGeminiModel();
    const modelClient = client.getGenerativeModel({ model });
    const imageData = screenshotBase64.startsWith("data:") ? screenshotBase64.split(",")[1] || "" : screenshotBase64;
    const result = await modelClient.generateContent([
      { text: promptText },
      { inlineData: { mimeType: "image/png", data: imageData } }
    ]);
    return result && result.response ? result.response.text() : "";
  }

  function getModelBudget(modelName) {
    const name = String(modelName || "").toLowerCase();
    // Heuristic budgets: small/default ~8k, large ~32k
    if (!name) return 8000;
    if (name.includes("gemini")) return 32000;
    if (name.includes("4k") || name.includes("8k") || name.includes("gpt-4o")) return 8000;
    return 8000;
  }

  return {
    getOpenAIClient,
    getGeminiClient,
    getOpenAIModel,
    getOpenAIResearchModel,
    getGeminiModel,
    callOpenAIChat,
    callOpenAIVision,
    callGeminiText,
    callGeminiVision,
    getModelBudget
  };
}

module.exports = { createModelService };

