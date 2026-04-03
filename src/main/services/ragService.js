const { generateEmbedding } = require("../rag/embeddingService");
const { createVectorStore } = require("../rag/vectorStore");

function createRagService(options = {}) {
  const vectorStore = createVectorStore(options.storeOptions || {});

  async function getRelevantContext(text) {
    const safeText = String(text || "").trim();
    if (!safeText) return [];
    try {
      const embeddingResult = await Promise.race([
        generateEmbedding(safeText),
        new Promise((resolve) => setTimeout(() => resolve(null), 1200))
      ]);
      if (!embeddingResult || !Array.isArray(embeddingResult.embedding)) return [];
      const results = await vectorStore.searchSimilar(embeddingResult.embedding, { topK: 3, provider: embeddingResult.provider });
      return results.map((r) => r.text);
    } catch (_err) {
      return [];
    }
  }

  async function storeMemory({ text, provider }) {
    const safeText = String(text || "").trim();
    if (!safeText) return false;
    try {
      const embeddingResult = await generateEmbedding(safeText);
      if (!embeddingResult || !Array.isArray(embeddingResult.embedding)) return false;
      return await vectorStore.addMemory({ text: safeText, embedding: embeddingResult.embedding, provider: embeddingResult.provider || provider });
    } catch (_err) {
      return false;
    }
  }

  return {
    getRelevantContext,
    storeMemory
  };
}

module.exports = { createRagService };
