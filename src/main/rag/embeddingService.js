const { fetchWithRetry } = require("../httpClient");
const LRUCache = require("../utils/lruCache");

// Simple in-memory cache for embeddings
const EMBEDDING_CACHE = new LRUCache(1024);
const EMBEDDING_TTL_MS = Number.isFinite(Number(process.env.EMBEDDING_CACHE_TTL_MS))
  ? Number(process.env.EMBEDDING_CACHE_TTL_MS)
  : 1000 * 60 * 60; // 1 hour default

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const MAX_EMBEDDING_CHARS = 2000;
const FALLBACK_DIM = 256;

let didWarnInvalidKey = false;

function isLikelyOpenAIKey(value) {
  const trimmed = String(value || "").trim();
  return trimmed.startsWith("sk-") && trimmed.length >= 20;
}

function getOpenAIKey() {
  const envKey = String(process.env.OPENAI_API_KEY || process.env.GPT_key || "").trim();
  if (!envKey) {
    return "";
  }
  if (!isLikelyOpenAIKey(envKey)) {
    if (!didWarnInvalidKey) {
      console.warn("OpenAI API key format looks invalid; embeddings will use local fallback.");
      didWarnInvalidKey = true;
    }
    return "";
  }
  return envKey;
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function clipText(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return "";
  }

  return normalized.length > MAX_EMBEDDING_CHARS
    ? normalized.slice(0, MAX_EMBEDDING_CHARS)
    : normalized;
}

function hashToken(token) {
  let hash = 5381;
  for (let index = 0; index < token.length; index += 1) {
    hash = (hash * 33) ^ token.charCodeAt(index);
  }
  return Math.abs(hash);
}

function normalizeVector(vector) {
  const sumSquares = vector.reduce((sum, value) => sum + value * value, 0);
  if (!sumSquares) {
    return vector;
  }
  const magnitude = Math.sqrt(sumSquares);
  return vector.map((value) => value / magnitude);
}

function generateFallbackEmbedding(text) {
  const vector = Array.from({ length: FALLBACK_DIM }, () => 0);
  const tokens = normalizeText(text).toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean);

  tokens.forEach((token) => {
    const index = hashToken(token) % FALLBACK_DIM;
    vector[index] += 1;
  });

  return {
    embedding: normalizeVector(vector),
    provider: "local"
  };
}

async function generateEmbedding(text) {
  const safeText = clipText(text);
  if (!safeText) {
    return { embedding: null, provider: "none" };
  }

  // use normalized key for cache
  const cacheKey = normalizeText(safeText).toLowerCase().slice(0, 1200);
  const cached = EMBEDDING_CACHE.get(cacheKey);
  if (cached) {
    if (!cached.ts || Date.now() - cached.ts < EMBEDDING_TTL_MS) {
      try { require("../utils/metrics").recordCacheHit("embedding", cacheKey); } catch (_e) {}
      return { embedding: cached.embedding, provider: cached.provider, model: cached.model };
    }
    // stale
    EMBEDDING_CACHE.delete(cacheKey);
    try { require("../utils/metrics").recordCacheMiss("embedding", cacheKey); } catch (_e) {}
  }

  const apiKey = getOpenAIKey();
  if (!apiKey) {
    return generateFallbackEmbedding(safeText);
  }

  const model = String(process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL).trim();

  try {
    const response = await fetchWithRetry(
      OPENAI_EMBEDDINGS_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({ model, input: safeText })
      },
      { timeoutMs: 10000, retries: 2, baseDelayMs: 400, label: "openai:embeddings" }
    );

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`OpenAI embeddings error (${response.status}): ${responseText}`);
    }

    const data = JSON.parse(responseText);
    const embedding = data && data.data && data.data[0] && data.data[0].embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new Error("OpenAI embeddings response missing data.");
    }
    const out = { embedding: normalizeVector(embedding), provider: "openai", model };
    try { EMBEDDING_CACHE.set(cacheKey, { embedding: out.embedding, provider: out.provider, model: out.model, ts: Date.now() }); require("../utils/metrics").recordCacheHit("embedding", cacheKey); } catch (_e) {}
    return out;
  } catch (error) {
    console.warn("Embeddings fallback to local:", String(error && error.message ? error.message : ""));
    const fallback = generateFallbackEmbedding(safeText);
    // cache fallback too
    try { EMBEDDING_CACHE.set(cacheKey, { embedding: fallback.embedding, provider: "local", model: "local", ts: Date.now() }); require("../utils/metrics").recordCacheMiss("embedding", cacheKey); } catch (_e) {}
    return fallback;
  }
}

// wrap original to cache successful OpenAI results
async function generateEmbeddingWithCache(text) {
  const safeText = clipText(text);
  if (!safeText) return { embedding: null, provider: "none" };
  const cacheKey = normalizeText(safeText).toLowerCase().slice(0, 1200);
  const cached = EMBEDDING_CACHE.get(cacheKey);
  if (cached && cached.embedding) {
    if (!cached.ts || Date.now() - cached.ts < EMBEDDING_TTL_MS) {
      return { embedding: cached.embedding, provider: cached.provider, model: cached.model };
    }
    EMBEDDING_CACHE.delete(cacheKey);
  }

  const result = await generateEmbedding(safeText);
  if (result && Array.isArray(result.embedding)) {
    try {
      EMBEDDING_CACHE.set(cacheKey, { embedding: result.embedding, provider: result.provider || "openai", model: result.model || "", ts: Date.now() });
    } catch (_e) {}
  }
  return result;
}

module.exports = {
  generateEmbedding: generateEmbeddingWithCache,
  normalizeVector
};
