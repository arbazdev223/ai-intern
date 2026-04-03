jest.mock("electron", () => {
  const path = require("path");
  const os = require("os");
  const fs = require("fs");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ifda-rag-"));
  return {
    app: {
      getPath: () => tempRoot
    }
  };
});

const path = require("path");
const fs = require("fs/promises");
const { app } = require("electron");
const { createVectorStore } = require("../src/main/rag/vectorStore");

const storePath = path.join(app.getPath("userData"), "rag", "memory.json");

async function resetStore() {
  try {
    await fs.rm(path.dirname(storePath), { recursive: true, force: true });
  } catch (_error) {}
}

describe("vectorStore.searchSimilar", () => {
  beforeEach(async () => {
    await resetStore();
  });

  test("BASIC SIMILARITY: most relevant entry returned first", async () => {
    const store = createVectorStore();
    await store.addMemory({ text: "alpha", embedding: [1, 0, 0] });
    await store.addMemory({ text: "beta", embedding: [0, 1, 0] });
    await store.addMemory({ text: "gamma", embedding: [0.2, 0.1, 0] });

    const results = await store.searchSimilar([1, 0, 0], { topK: 3 });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toBe("alpha");
  });

  test("TOP K LIMIT: returns only topK results", async () => {
    const store = createVectorStore();
    for (let i = 0; i < 10; i += 1) {
      await store.addMemory({ text: `item ${i + 1}`, embedding: [1, 0, 0] });
    }

    const results = await store.searchSimilar([1, 0, 0], { topK: 3 });
    expect(results).toHaveLength(3);
  });

  test("EMPTY STORE: returns empty array", async () => {
    const store = createVectorStore();
    const results = await store.searchSimilar([1, 0, 0], { topK: 3 });
    expect(results).toEqual([]);
  });

  test("DUPLICATE PREVENTION: duplicate text not stored twice", async () => {
    const store = createVectorStore();
    const first = await store.addMemory({ text: "duplicate", embedding: [1, 0, 0] });
    const second = await store.addMemory({ text: "duplicate", embedding: [1, 0, 0] });

    expect(first).toBe(true);
    expect(second).toBe(false);

    const results = await store.searchSimilar([1, 0, 0], { topK: 5 });
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe("duplicate");
  });

  test("ORDERING: results sorted by similarity descending", async () => {
    const store = createVectorStore();
    await store.addMemory({ text: "high", embedding: [1, 0, 0] });
    await store.addMemory({ text: "mid", embedding: [0.6, 0, 0] });
    await store.addMemory({ text: "low", embedding: [0.3, 0, 0] });

    const results = await store.searchSimilar([1, 0, 0], { topK: 3 });

    expect(results[0].text).toBe("high");
    expect(results[1].text).toBe("mid");
    expect(results[2].text).toBe("low");
  });

  test("SIMILARITY THRESHOLD: filters below threshold and keeps ordering", async () => {
    const store = createVectorStore();
    await store.addMemory({ text: "high", embedding: [0.9, 0.1] });
    await store.addMemory({ text: "borderline", embedding: [0.18, 0] });
    await store.addMemory({ text: "low", embedding: [0.1, 0.9] });

    const results = await store.searchSimilar([1, 0], { topK: 3 });

    expect(results.length).toBe(1);
    expect(results[0].text).toBe("high");
  });

  test("SIMILARITY THRESHOLD: mixed results only return above threshold", async () => {
    const store = createVectorStore();
    await store.addMemory({ text: "high-1", embedding: [0.95, 0.05] });
    await store.addMemory({ text: "high-2", embedding: [0.7, 0.1] });
    await store.addMemory({ text: "low-1", embedding: [0.05, 0.95] });
    await store.addMemory({ text: "low-2", embedding: [0.1, 0.4] });

    const results = await store.searchSimilar([1, 0], { topK: 5 });

    expect(results.map((item) => item.text)).toEqual(["high-1", "high-2"]);
  });

  test("SIMILARITY THRESHOLD: topK respected after filtering", async () => {
    const store = createVectorStore();
    await store.addMemory({ text: "high-1", embedding: [0.9, 0.1] });
    await store.addMemory({ text: "high-2", embedding: [0.85, 0.05] });
    await store.addMemory({ text: "high-3", embedding: [0.8, 0.02] });
    await store.addMemory({ text: "low", embedding: [0.1, 0.9] });

    const results = await store.searchSimilar([1, 0], { topK: 2 });

    expect(results).toHaveLength(2);
    expect(results[0].text).toBe("high-1");
    expect(results[1].text).toBe("high-2");
  });

  test("SIMILARITY THRESHOLD: score equals 0.18 is excluded (strict)", async () => {
    const store = createVectorStore();
    await store.addMemory({ text: "boundary", embedding: [0.18, 0] });
    await store.addMemory({ text: "above", embedding: [0.181, 0] });

    const results = await store.searchSimilar([1, 0], { topK: 3 });

    expect(results.map((item) => item.text)).toEqual(["above"]);
  });
});
