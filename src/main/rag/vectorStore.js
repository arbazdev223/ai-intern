const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { app } = require("electron");

const DEFAULT_MAX_ENTRIES = 500;
const STORE_DIR = "rag";
const STORE_FILE = "memory.json";

function createVectorStore(options = {}) {
  const maxEntries = Number.isFinite(options.maxEntries) ? options.maxEntries : DEFAULT_MAX_ENTRIES;
  let store = { entries: [] };
  let loaded = false;
  let writePromise = Promise.resolve();

  function getStorePath() {
    const base =
      app && typeof app.getPath === "function"
        ? app.getPath("userData")
        : path.join(os.tmpdir(), "ifda-ai");
    return path.join(base, STORE_DIR, STORE_FILE);
  }

  async function ensureLoaded() {
    if (loaded) {
      return;
    }

    const filePath = getStorePath();
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.entries)) {
        store.entries = parsed.entries;
      }
    } catch (_error) {
      store.entries = [];
    }

    loaded = true;
  }

  async function persist() {
    const filePath = getStorePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ entries: store.entries }), "utf8");
  }

  function prune() {
    if (store.entries.length > maxEntries) {
      store.entries = store.entries.slice(-maxEntries);
    }
  }

  function isDuplicate(textKey) {
    const recent = store.entries.slice(-30);
    return recent.some((entry) => entry.textKey === textKey);
  }

  function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return 0;
    }

    let dot = 0;
    for (let i = 0; i < a.length; i += 1) {
      dot += a[i] * b[i];
    }
    return dot;
  }

  async function addMemory(payload = {}) {
    await ensureLoaded();

    const text = String(payload.text || "").trim();
    const embedding = payload.embedding;
    const provider = String(payload.provider || "local").trim() || "local";
    if (!text || !Array.isArray(embedding) || embedding.length === 0) {
      return false;
    }

    const textKey = text.toLowerCase();
    if (isDuplicate(textKey)) {
      return false;
    }

    store.entries.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      textKey,
      embedding,
      provider,
      timestamp: Date.now()
    });

    prune();
    writePromise = writePromise.then(persist).catch(() => {});
    try {
      await writePromise;
    } catch (_e) {}
    return true;
  }

  async function searchSimilar(queryEmbedding, options = {}) {
    await ensureLoaded();

    const topK = Number.isFinite(options.topK) ? options.topK : 3;
    const provider = String(options.provider || "").trim();

    const scored = store.entries
      .filter((entry) => Array.isArray(entry.embedding))
      .filter((entry) => !provider || entry.provider === provider)
      .map((entry) => ({
        text: entry.text,
        score: cosineSimilarity(queryEmbedding, entry.embedding),
        key: String(entry.text || "").toLowerCase()
      }))
      .filter((entry) => entry.score > 0.18)
      .sort((a, b) => b.score - a.score);

    // Deduplicate by text key while preserving order
    const seen = new Set();
    const unique = [];
    for (const item of scored) {
      if (!seen.has(item.key)) {
        seen.add(item.key);
        unique.push({ text: item.text, score: item.score });
      }
      if (unique.length >= topK) break;
    }

    return unique;
  }

  return {
    addMemory,
    searchSimilar
  };
}

module.exports = {
  createVectorStore
};
