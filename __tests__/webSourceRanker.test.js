const { rankAndFilterWebSources, stripTrackingParams } = require("../src/main/utils/webSourceRanker");

describe("webSourceRanker", () => {
  test("stripTrackingParams removes utm_* and common trackers", () => {
    const url =
      "https://example.com/path?a=1&utm_source=openai&utm_medium=chat&gclid=123&fbclid=456#x";
    const stripped = stripTrackingParams(url);
    expect(stripped).toContain("https://example.com/path?");
    expect(stripped).toContain("a=1");
    expect(stripped).not.toContain("utm_source");
    expect(stripped).not.toContain("utm_medium");
    expect(stripped).not.toContain("gclid");
    expect(stripped).not.toContain("fbclid");
  });

  test("rankAndFilterWebSources prefers trusted domains over low-quality ones", () => {
    const sources = [
      { title: "Random blog", url: "https://someblogspot.example/blog/ai-tools-2026", snippet: "..." },
      { title: "Medium post", url: "https://medium.com/@x/ai-tools-2026", snippet: "..." },
      { title: "Reuters story", url: "https://www.reuters.com/technology/ai-tools-2026/", snippet: "Reuters snippet content that is long enough to count." },
      { title: "OpenAI docs", url: "https://openai.com/blog/", snippet: "Official content." }
    ];

    const ranked = rankAndFilterWebSources(sources, { max: 3, preferTrusted: true });
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].url).toMatch(/openai\.com|reuters\.com/i);
    expect(ranked.some((s) => /reuters\.com/i.test(s.url))).toBe(true);
  });

  test("rankAndFilterWebSources dedupes urls and drops non-http entries", () => {
    const sources = [
      { title: "A", url: "https://openai.com/?utm_source=openai" },
      { title: "B", url: "https://openai.com/" },
      { title: "C", url: "mailto:test@example.com" },
      { title: "D", url: "" }
    ];
    const ranked = rankAndFilterWebSources(sources, { max: 10 });
    expect(ranked.length).toBe(1);
    expect(ranked[0].url).toBe("https://openai.com/");
  });
});

