const mockFetchWithRetry = jest.fn();

jest.mock("../src/main/httpClient", () => ({
  fetchWithRetry: (...args) => mockFetchWithRetry(...args)
}));

const { searchWeb } = require("../tools/webSearch");

describe("webSearch relevance", () => {
  beforeEach(() => {
    mockFetchWithRetry.mockReset();
  });

  test("news intent uses Google News RSS search first", async () => {
    const rss = `
      <rss><channel>
        <item>
          <title>Global markets react to fresh policy signals</title>
          <link>https://news.google.com/articles/abc</link>
          <description>Markets moved after major updates.</description>
        </item>
      </channel></rss>
    `;

    mockFetchWithRetry.mockImplementation(async (url) => {
      if (String(url).includes("news.google.com/rss/search")) {
        return { ok: true, text: async () => rss };
      }

      return { ok: true, text: async () => "<rss><channel></channel></rss>" };
    });

    const result = await searchWeb("search karke batao mujhe duniya me abhi kya chal raha hai");

    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources[0].title).toContain("Global markets");
    const wikiCalls = mockFetchWithRetry.mock.calls.filter((args) =>
      String(args[0]).includes("wikipedia.org/w/api.php")
    );
    expect(wikiCalls.length).toBe(0);
  });

  test("world-scope news query filters noisy entertainment headlines", async () => {
    const rss = `
      <rss><channel>
        <item>
          <title>Kishore Kumar Biography: Birth, Age, Death</title>
          <link>https://news.google.com/articles/noisy-1</link>
          <description>Biography and songs collection.</description>
        </item>
        <item>
          <title>Global markets react to oil price volatility</title>
          <link>https://news.google.com/articles/world-1</link>
          <description>International markets respond to global cues.</description>
        </item>
      </channel></rss>
    `;

    mockFetchWithRetry.mockImplementation(async (url) => {
      if (String(url).includes("news.google.com/rss/search")) {
        return { ok: true, text: async () => rss };
      }
      return { ok: true, text: async () => "<rss><channel></channel></rss>" };
    });

    const result = await searchWeb("duniya me abhi latest world news kya hai");

    expect(result.sources.length).toBe(1);
    expect(result.sources[0].title).toContain("Global markets react");
  });

  test("broad world-news query rejects sports and devotional-only headlines", async () => {
    const rss = `
      <rss><channel>
        <item>
          <title>World Aquatic Artistic Swimming WC Super Final</title>
          <link>https://news.google.com/articles/sports-1</link>
          <description>Championship highlights and records.</description>
        </item>
        <item>
          <title>Dekho yeh Parmeshwar ka Memna hai</title>
          <link>https://news.google.com/articles/devotional-1</link>
          <description>Faith reflection and sermon text.</description>
        </item>
      </channel></rss>
    `;

    mockFetchWithRetry.mockImplementation(async (url) => {
      if (String(url).includes("news.google.com/rss/search")) {
        return { ok: true, text: async () => rss };
      }

      if (String(url).includes("news.google.com/rss?")) {
        return { ok: true, text: async () => "<rss><channel></channel></rss>" };
      }

      if (String(url).includes("rss.xml") || String(url).includes("/world/rss") || String(url).includes("aljazeera.com/xml/rss")) {
        return { ok: true, text: async () => "<rss><channel></channel></rss>" };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await searchWeb("duniya me abhi kya chal raha hai");

    expect(result.sources).toEqual([]);
    expect(result.summary).toContain("Reliable current-events sources nahi mile");
  });

  test("knowledge intent uses Wikipedia API", async () => {
    mockFetchWithRetry.mockImplementation(async (url) => {
      if (String(url).includes("wikipedia.org/w/api.php")) {
        return {
          ok: true,
          json: async () => ({
            query: {
              search: [
                {
                  pageid: 123,
                  title: "Node.js",
                  snippet: "Node.js is an open-source JavaScript runtime environment."
                }
              ]
            }
          })
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await searchWeb("what is nodejs");

    expect(result.summary).toContain("JavaScript runtime");
    expect(result.sources[0].url).toContain("wikipedia.org");
    const ddgCalls = mockFetchWithRetry.mock.calls.filter((args) =>
      String(args[0]).includes("duckduckgo")
    );
    expect(ddgCalls.length).toBe(0);
  });

  test("general query can return instant summary without html fallback", async () => {
    mockFetchWithRetry.mockImplementation(async (url) => {
      if (String(url).includes("api.duckduckgo.com")) {
        return {
          ok: true,
          json: async () => ({
            AbstractText: "Node.js is a JavaScript runtime.",
            RelatedTopics: []
          })
        };
      }

      return {
        ok: true,
        text: async () => "<html></html>"
      };
    });

    const result = await searchWeb("best javascript editor tools");

    expect(result.summary).toContain("JavaScript runtime");
    const htmlCalls = mockFetchWithRetry.mock.calls.filter((args) =>
      String(args[0]).includes("duckduckgo.com/html")
    );
    expect(htmlCalls.length).toBe(0);
  });

  test("news intent falls back to clear message when no relevant source is found", async () => {
    mockFetchWithRetry.mockImplementation(async (url) => {
      if (String(url).includes("news.google.com/rss/search")) {
        return {
          ok: true,
          text: async () => "<rss><channel></channel></rss>"
        };
      }

      if (String(url).includes("news.google.com/rss?")) {
        return {
          ok: true,
          text: async () => "<rss><channel></channel></rss>"
        };
      }

      if (String(url).includes("rss.xml") || String(url).includes("/world/rss")) {
        return {
          ok: true,
          text: async () => "<rss><channel></channel></rss>"
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await searchWeb("latest world news update");

    expect(result.sources).toEqual([]);
    expect(result.summary).toContain("Reliable current-events sources nahi mile");
  });

  test("freshness-sensitive query excludes stale headlines", async () => {
    const oldDate = "Sat, 29 Mar 2026 05:00:00 GMT";
    const freshDate = "Mon, 30 Mar 2026 10:30:00 GMT";

    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-03-30T12:00:00.000Z"));

    mockFetchWithRetry.mockImplementation(async (url) => {
      if (String(url).includes("news.google.com/rss/search")) {
        return {
          ok: true,
          text: async () => `
            <rss><channel>
              <item>
                <title>IPL match preview from yesterday</title>
                <link>https://news.google.com/articles/stale-1</link>
                <description>Older preview details.</description>
                <pubDate>${oldDate}</pubDate>
              </item>
              <item>
                <title>Today IPL match starts at 7:30 PM</title>
                <link>https://news.google.com/articles/fresh-1</link>
                <description>Latest lineup and venue updates.</description>
                <pubDate>${freshDate}</pubDate>
              </item>
            </channel></rss>
          `
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await searchWeb("aaj ipl ka match kaunsa hai");

    expect(result.sources.length).toBe(1);
    expect(result.sources[0].title).toContain("Today IPL match");

    jest.useRealTimers();
  });

  test("news query drops garbled mojibake titles", async () => {
    mockFetchWithRetry.mockImplementation(async (url) => {
      if (String(url).includes("news.google.com/rss/search")) {
        return {
          ok: true,
          text: async () => `
            <rss><channel>
              <item>
                <title>αñçαñ£αñ░αñ╛αñ»αñ▓ αñòαñ╛ αñêαñ░αñ╛αñ¿ - AajTak</title>
                <link>https://news.google.com/articles/moji-1</link>
                <description>Garbled text sample.</description>
                <pubDate>Mon, 30 Mar 2026 10:30:00 GMT</pubDate>
              </item>
              <item>
                <title>IPL 2026 Schedule and Today's Match</title>
                <link>https://news.google.com/articles/clean-1</link>
                <description>Clean readable update.</description>
                <pubDate>Mon, 30 Mar 2026 10:45:00 GMT</pubDate>
              </item>
            </channel></rss>
          `
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await searchWeb("aaj ipl update do");

    expect(result.sources.length).toBe(1);
    expect(result.sources[0].title).toContain("IPL 2026 Schedule");
  });
});
