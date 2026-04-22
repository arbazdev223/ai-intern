const { searchWeb } = require("../../tools/webSearch");
const { getEnv } = require("./config/env");
const { rankAndFilterWebSources } = require("./utils/webSourceRanker");

function isLikelyOpenAIKey(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return false;
  }

  return trimmed.startsWith("sk-") && trimmed.length >= 16;
}

function extractFirstJsonObject(text) {
  const source = String(text || "").trim();
  if (!source) return null;

  const fenceMatch = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1] : source;

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  const slice = candidate.slice(start, end + 1).trim();
  try {
    return JSON.parse(slice);
  } catch (_error) {
    return null;
  }
}

function normalizeUrl(value) {
  const safe = String(value || "").trim();
  if (!safe) return "";
  if (!/^https?:\/\//i.test(safe)) return "";
  return safe;
}

function normalizeOpenAiWebResult(payload) {
  const outputText =
    String(payload && payload.output_text ? payload.output_text : "")
      .replace(/\u0000/g, "")
      .trim() || "";

  const json = extractFirstJsonObject(outputText);
  const summary = String(json && json.summary ? json.summary : outputText).trim();

  const sourcesFromJson = Array.isArray(json && json.sources)
    ? json.sources
        .map((item) => ({
          title: String(item && item.title ? item.title : "").trim(),
          url: normalizeUrl(item && item.url ? item.url : ""),
          snippet: String(item && item.snippet ? item.snippet : "").trim()
        }))
        .filter((item) => item.url)
    : [];

  // Best-effort: also look for tool annotations inside output items.
  const sourcesFromAnnotations = [];
  try {
    const output = Array.isArray(payload && payload.output) ? payload.output : [];
    output.forEach((item) => {
      if (!item || item.type !== "message" || !Array.isArray(item.content)) return;
      item.content.forEach((part) => {
        if (!part || part.type !== "output_text") return;
        const annotations = Array.isArray(part.annotations) ? part.annotations : [];
        annotations.forEach((ann) => {
          const url = normalizeUrl(ann && ann.url ? ann.url : "");
          if (!url) return;
          const title = String(ann && (ann.title || ann.text) ? (ann.title || ann.text) : "").trim();
          sourcesFromAnnotations.push({
            title: title || url,
            url,
            snippet: ""
          });
        });
      });
    });
  } catch (_error) {}

  const mergedSources = [...sourcesFromJson, ...sourcesFromAnnotations].reduce((acc, item) => {
    if (!item || !item.url) return acc;
    if (acc.some((existing) => existing.url === item.url)) return acc;
    acc.push(item);
    return acc;
  }, []);

  const rankedSources = rankAndFilterWebSources(mergedSources, { max: 6, preferTrusted: true });

  return {
    summary: summary || "No direct summary found.",
    relatedTopics: Array.isArray(json && json.relatedTopics) ? json.relatedTopics.slice(0, 6) : [],
    sources: rankedSources
  };
}

function createSearchService() {
  let openAiClient = null;

  function getOpenAiClient() {
    if (openAiClient) {
      return openAiClient;
    }

    const env = getEnv();
    const apiKey = String(env.OPENAI_API_KEY || "").trim();
    if (!isLikelyOpenAIKey(apiKey)) {
      return null;
    }

    // Lazy init to avoid loading OpenAI client in tests/when not configured.
    // eslint-disable-next-line global-require
    const OpenAI = require("openai");
    openAiClient = new OpenAI({ apiKey });
    return openAiClient;
  }

  async function searchWithOpenAiWebTool(query) {
    const env = getEnv();
    const model = String(env.OPENAI_MODEL || "gpt-4o-mini").trim() || "gpt-4o-mini";
    const client = getOpenAiClient();
    if (!client || !client.responses || typeof client.responses.create !== "function") {
      throw new Error("OpenAI web search unavailable");
    }

    const prompt = [
      "You are a web research tool.",
      `Search the web for: ${String(query || "").trim()}`,
      "",
      "Return STRICT JSON only with this shape:",
      '{ "summary": string, "sources": [{"title": string, "url": string, "snippet": string}] }',
      "",
      "Rules:",
      "- Include 3-6 sources with https URLs when possible.",
      "- Summary must be concise and factual.",
      "- If the query is about latest/current events, prioritize recent sources."
    ].join("\n");

    const toolChoices = [
      [{ type: "web_search" }],
      [{ type: "web_search_preview" }]
    ];

    let lastError = null;
    for (const tools of toolChoices) {
      try {
        const response = await client.responses.create({
          model,
          input: prompt,
          tools
        });
        return normalizeOpenAiWebResult(response);
      } catch (error) {
        lastError = error;
      }
    }

    const message = String(lastError && lastError.message ? lastError.message : lastError || "").trim();
    throw new Error(message || "OpenAI web search failed");
  }

  async function search(query) {
    const safeQuery = String(query || "").trim();
    if (!safeQuery) {
      return {
        summary: "",
        relatedTopics: [],
        sources: []
      };
    }

    // Prefer OpenAI's web_search tool when OpenAI is configured, otherwise fall back to the local crawler.
    try {
      const env = getEnv();
      if (env && env.OPENAI_API_KEY) {
        return await searchWithOpenAiWebTool(safeQuery);
      }
    } catch (_error) {
      // Keep best-effort behavior and fall back to the existing search stack.
    }

    return searchWeb(safeQuery);
  }

  return {
    search
  };
}

module.exports = {
  createSearchService
};
