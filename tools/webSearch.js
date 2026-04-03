const DUCKDUCKGO_API_URL = "https://api.duckduckgo.com/";
const DUCKDUCKGO_HTML_URL = "https://duckduckgo.com/html/";
const GOOGLE_NEWS_RSS_SEARCH_URL = "https://news.google.com/rss/search";
const GOOGLE_NEWS_RSS_TOP_URL = "https://news.google.com/rss";
const WIKIPEDIA_API_URL = "https://en.wikipedia.org/w/api.php";
const { fetchWithRetry } = require("../src/main/httpClient");

const TRUSTED_WORLD_NEWS_FEEDS = [
  { source: "BBC", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { source: "The Guardian", url: "https://www.theguardian.com/world/rss" },
  { source: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { source: "Reuters", url: "https://www.reuters.com/world/rss" }
];

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtml(html) {
  const decoded = decodeHtmlEntities(String(html || ""));
  return decoded
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractXmlTag(block, tagName) {
  const pattern = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = String(block || "").match(pattern);
  if (!match || !match[1]) {
    return "";
  }
  return stripHtml(match[1]);
}

function parseRssItems(xml, sourceName) {
  const feedText = String(xml || "");
  if (!feedText) {
    return [];
  }

  const items = [...feedText.matchAll(/<item\b[\s\S]*?<\/item>/gi)]
    .slice(0, 8)
    .map((match) => {
      const block = match[0];
      const title = extractXmlTag(block, "title");
      const link = extractXmlTag(block, "link");
      const snippet = extractXmlTag(block, "description");
      const pubDate = extractXmlTag(block, "pubDate");
      if (!title || !link) {
        return null;
      }

      return {
        title,
        url: link,
        snippet: snippet ? snippet.slice(0, 260) : pubDate,
        source: sourceName,
        pubDate,
        publishedAt: (() => {
          const ts = Date.parse(pubDate);
          return Number.isFinite(ts) ? ts : null;
        })()
      };
    })
    .filter(Boolean);

  return items;
}

function flattenRelatedTopics(items, limit = 5, acc = []) {
  if (!Array.isArray(items) || acc.length >= limit) {
    return acc;
  }

  for (const item of items) {
    if (acc.length >= limit) {
      break;
    }

    if (item && typeof item.Text === "string" && item.Text.trim()) {
      acc.push(item.Text.trim());
      continue;
    }

    if (item && Array.isArray(item.Topics)) {
      flattenRelatedTopics(item.Topics, limit, acc);
    }
  }

  return acc;
}

function normalizeSearchQuery(query) {
  return String(query || "")
    .replace(/\b(what\s+is|who\s+is|full\s*form|meaning|definition|latest|search|for me|for)\b/gi, " ")
    .replace(/[?:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getQueryTokens(query) {
  return String(query || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2)
    .slice(0, 16);
}

function getTokenOverlapScore(query, text) {
  const tokens = getQueryTokens(query);
  if (tokens.length === 0) {
    return 0;
  }

  const rawHaystack = String(text || "").toLowerCase();
  const normalizedHaystack = rawHaystack.replace(/[^a-z0-9\s]/g, " ");
  const compactHaystack = normalizedHaystack.replace(/\s+/g, "");
  let matches = 0;
  tokens.forEach((token) => {
    if (normalizedHaystack.includes(token) || compactHaystack.includes(token)) {
      matches += 1;
    }
  });
  return matches;
}

function isNewsIntentQuery(query) {
  const text = String(query || "").toLowerCase();
  if (!text) {
    return false;
  }

  const patterns = [
    /\b(latest|today|current|breaking|headline|news|update)\b/,
    /\b(abhi|aaj|duniya|kya\s+chal\s+raha)\b/,
    /\b(world|global|international|geopolitics?)\b/
  ];

  return patterns.some((pattern) => pattern.test(text));
}

function requiresWorldScope(query) {
  const text = String(query || "").toLowerCase();
  if (!text) {
    return false;
  }

  return /\b(world|global|international|duniya|vishwa|geopolitics?)\b/.test(text);
}

function isBroadWorldNewsQuery(query) {
  const text = String(query || "").toLowerCase();
  if (!text || !requiresWorldScope(text)) {
    return false;
  }

  return /\b(abhi|aaj|latest|today|current|headline|headlines|news|update|updates|kya\s+chal\s+raha)\b/.test(text);
}

function isFreshnessSensitiveQuery(query) {
  const text = String(query || "").toLowerCase();
  if (!text) {
    return false;
  }

  return /\b(aaj|abhi|today|current|currently|live|now|latest|new|breaking|today's)\b/.test(text);
}

function getFreshnessWindowMs(query) {
  const text = String(query || "").toLowerCase();
  if (/\b(aaj|today|today's)\b/.test(text)) {
    return 1000 * 60 * 60 * 24;
  }

  return 1000 * 60 * 60 * 36;
}

function looksLikeMojibake(text) {
  const safeText = String(text || "");
  if (!safeText) {
    return false;
  }

  return /(ΓÇ|αñ|Ã.|Â.|â.|�)/.test(safeText);
}

function hasHardNewsSignal(text) {
  const safeText = String(text || "").toLowerCase();
  if (!safeText) {
    return false;
  }

  return /\b(news|breaking|update|updates|policy|government|election|ceasefire|conflict|war|economy|economic|market|inflation|tariff|trade|sanction|summit|parliament|diplomatic|security|border|earthquake|flood|wildfire)\b/.test(safeText);
}

function hasOffTopicSignal(text) {
  const safeText = String(text || "").toLowerCase();
  if (!safeText) {
    return false;
  }

  return /\b(song|lyrics|music|biography|movie|cinema|box office|celebrity|tv|serial|cricket|ipl|football|boxing|wrestling|swimming|medal|championship|record|gospel|church|sermon|prayer|bhajan|devotional|exam|prelims|result|admit card|typing)\b/.test(safeText);
}

function getPublisherQualityBonus(text) {
  const safeText = String(text || "").toLowerCase();
  if (!safeText) {
    return 0;
  }

  if (/\b(reuters|associated press|ap news|bbc|financial times|ft|the economist|the guardian|al jazeera|bloomberg|wsj|wall street journal|new york times|washington post|dw|france 24|npr|cnbc|cnn|abc news|cbs news)\b/.test(safeText)) {
    return 3;
  }

  return 0;
}

function scoreNewsHeadline(headlineText, options = {}) {
  const text = String(headlineText || "").toLowerCase();
  if (!text) {
    return -10;
  }

  let score = 0;
  const worldSignals = [
    "world",
    "global",
    "international",
    "geopolit",
    "united nations",
    "conflict",
    "war",
    "economy",
    "market",
    "inflation",
    "trade",
    "diplom",
    "middle east",
    "europe",
    "china",
    "us",
    "ukraine"
  ];
  worldSignals.forEach((token) => {
    if (text.includes(token)) {
      score += 2;
    }
  });

  const hardNewsSignals = [
    "news",
    "update",
    "breaking",
    "summit",
    "policy",
    "government",
    "election"
  ];
  hardNewsSignals.forEach((token) => {
    if (text.includes(token)) {
      score += 1;
    }
  });

  const noisySignals = [
    "biography",
    "song",
    "lyrics",
    "music",
    "award",
    "class",
    "prelims",
    "exam",
    "astrology",
    "tv live",
    "celebrity",
    "entertainment",
    "swimming",
    "boxing",
    "football",
    "cricket",
    "church",
    "sermon",
    "devotional"
  ];
  noisySignals.forEach((token) => {
    if (text.includes(token)) {
      score -= 4;
    }
  });

  if (options.worldScope) {
    if (score <= 0) {
      score -= 2;
    }
  }

  return score;
}

function filterNewsResultByQuery(query, result) {
  const worldScope = requiresWorldScope(query);
  const broadWorldQuery = isBroadWorldNewsQuery(query);
  const freshnessSensitiveQuery = isFreshnessSensitiveQuery(query);
  const nowTs = Date.now();
  const freshWindowMs = getFreshnessWindowMs(query);
  const list = Array.isArray(result && result.sources) ? result.sources : [];
  const scored = list
    .map((item) => {
      const title = String(item && item.title ? item.title : "").trim();
      const snippet = String(item && item.snippet ? item.snippet : "").trim();
      const source = String(item && item.source ? item.source : "").trim();
      const combined = `${title} ${snippet} ${source}`.trim();
      const hardNewsSignal = hasHardNewsSignal(combined);
      const offTopicSignal = hasOffTopicSignal(combined);
      const publisherBonus = getPublisherQualityBonus(combined);
      const mojibakeSignal = looksLikeMojibake(combined);
      const publishedAt = Number.isFinite(Number(item && item.publishedAt)) ? Number(item.publishedAt) : null;
      const ageMs = publishedAt ? Math.max(0, nowTs - publishedAt) : null;
      const staleForFreshQuery = freshnessSensitiveQuery && Number.isFinite(ageMs) && ageMs > freshWindowMs;

      let score = scoreNewsHeadline(combined, { worldScope });
      score += publisherBonus;

      if (mojibakeSignal) {
        score -= 10;
      }

      if (staleForFreshQuery) {
        score -= 6;
      }

      if (broadWorldQuery) {
        if (hardNewsSignal) {
          score += 3;
        }
        if (offTopicSignal) {
          score -= 6;
        }
      }

      if (worldScope && !hardNewsSignal && publisherBonus <= 0) {
        score -= 2;
      }

      return {
        ...item,
        score,
        hardNewsSignal,
        offTopicSignal,
        mojibakeSignal,
        staleForFreshQuery
      };
    })
    .sort((a, b) => b.score - a.score);

  const threshold = broadWorldQuery ? 3 : worldScope ? 2 : 0;
  const filtered = scored
    .filter((item) => {
      if (item.score < threshold) {
        return false;
      }

      if (item.mojibakeSignal) {
        return false;
      }

      if (freshnessSensitiveQuery && item.staleForFreshQuery) {
        return false;
      }

      if (!broadWorldQuery) {
        return true;
      }

      if (item.offTopicSignal && !item.hardNewsSignal) {
        return false;
      }

      return item.hardNewsSignal || item.score >= threshold + 2;
    })
    .slice(0, 8)
    .map(({ score, hardNewsSignal, offTopicSignal, mojibakeSignal, staleForFreshQuery, ...rest }) => rest);

  return {
    summary: buildHeadlineSummary(filtered),
    relatedTopics: filtered.map((item) => item.title).slice(0, 6),
    sources: filtered
  };
}

function isKnowledgeIntentQuery(query) {
  const text = String(query || "").toLowerCase();
  if (!text) {
    return false;
  }

  const patterns = [
    /\bwhat\s+is\b/,
    /\bwho\s+is\b/,
    /\bmeaning\b/,
    /\bdefinition\b/,
    /\bhistory\b/,
    /\bexplain\b/,
    /\bkya\s+hai\b/,
    /\bkaun\s+hai\b/
  ];

  return patterns.some((pattern) => pattern.test(text));
}

function classifySearchIntent(query) {
  if (isNewsIntentQuery(query)) {
    return "latest_news";
  }
  if (isKnowledgeIntentQuery(query)) {
    return "knowledge";
  }
  return "general";
}

function isCurrentEventsQuery(query) {
  const text = String(query || "").toLowerCase();
  if (!text) {
    return false;
  }

  const patterns = [
    /\b(world|global|international|geopolitics?)\b/,
    /\b(latest|today|current|breaking|headline|news|updates?)\b/,
    /\b(abhi|aaj|duniya|kya\s+chal\s+raha)\b/
  ];

  return patterns.some((pattern) => pattern.test(text));
}

function buildCandidateQueries(query) {
  const safeQuery = String(query || "").trim();
  const candidates = [];
  const seen = new Set();

  function addCandidate(value) {
    const next = String(value || "").trim();
    if (!next) {
      return;
    }
    const key = next.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(next);
  }

  addCandidate(safeQuery);

  const normalized = normalizeSearchQuery(safeQuery);
  if (normalized && normalized.toLowerCase() !== safeQuery.toLowerCase()) {
    addCandidate(normalized);
  }

  if (isCurrentEventsQuery(safeQuery)) {
    addCandidate(`${normalized || safeQuery} latest world news`);
    addCandidate("latest world news Reuters AP BBC");
  }

  return candidates;
}

function hasUsefulSummary(summary) {
  const text = String(summary || "").trim().toLowerCase();
  return Boolean(text) && text !== "no direct summary found.";
}

function buildHeadlineSummary(items) {
  const list = Array.isArray(items) ? items.slice(0, 4) : [];
  if (list.length === 0) {
    return "No direct summary found.";
  }

  return list.map((item) => String(item.title || "").trim()).filter(Boolean).join("\n");
}

function toAbsoluteDuckDuckGoLink(href) {
  const cleaned = decodeHtmlEntities(String(href || "").trim());

  if (!cleaned) {
    return "";
  }

  if (cleaned.startsWith("http://") || cleaned.startsWith("https://")) {
    return cleaned;
  }

  if (cleaned.startsWith("//")) {
    return `https:${cleaned}`;
  }

  if (cleaned.startsWith("/")) {
    return `https://duckduckgo.com${cleaned}`;
  }

  return cleaned;
}

function unwrapDuckDuckGoRedirect(urlValue) {
  const safeUrl = String(urlValue || "").trim();
  if (!safeUrl) {
    return "";
  }

  try {
    const parsed = new URL(safeUrl);
    const host = parsed.hostname.toLowerCase();
    if (host.includes("duckduckgo.com") && parsed.pathname.startsWith("/l/")) {
      const uddg = parsed.searchParams.get("uddg");
      if (uddg) {
        return decodeURIComponent(uddg);
      }
    }
    return parsed.toString();
  } catch (_error) {
    return safeUrl;
  }
}

function getHostname(urlValue) {
  const safeUrl = String(urlValue || "").trim();
  if (!safeUrl) {
    return "";
  }

  try {
    return new URL(safeUrl).hostname.toLowerCase();
  } catch (_error) {
    return "";
  }
}

function isLowQualitySource(item) {
  const title = String(item && item.title ? item.title : "").toLowerCase();
  const snippet = String(item && item.snippet ? item.snippet : "").toLowerCase();
  const host = getHostname(item && item.url ? item.url : "");
  const combined = `${title} ${snippet}`;

  const badHosts = [
    "translate.google",
    "youtube.com",
    "youtu.be",
    "easyhindityping.com"
  ];
  if (badHosts.some((domain) => host.includes(domain))) {
    return true;
  }

  const badSignals = [
    "translate",
    "lyrics",
    "song",
    "music video",
    "typing"
  ];

  return badSignals.some((token) => combined.includes(token));
}

function scoreSource(item, query, currentEventsMode) {
  const title = String(item && item.title ? item.title : "").toLowerCase();
  const snippet = String(item && item.snippet ? item.snippet : "").toLowerCase();
  const host = getHostname(item && item.url ? item.url : "");
  const combined = `${title} ${snippet}`;
  const queryTokens = String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2)
    .slice(0, 12);

  let score = 0;
  queryTokens.forEach((token) => {
    if (combined.includes(token)) {
      score += 1;
    }
  });

  if (currentEventsMode) {
    if (/\b(news|live|update|world|global|war|economy|market)\b/.test(combined)) {
      score += 3;
    }

    // Lightweight host quality signal (not strict allowlist).
    if (/\.(gov|edu)\b/.test(host)) {
      score += 2;
    }
  }

  if (isLowQualitySource(item)) {
    score -= 8;
  }

  return score;
}

function rankAndFilterSources(sources, query, currentEventsMode) {
  const ranked = (Array.isArray(sources) ? sources : [])
    .map((item) => ({
      ...item,
      score: scoreSource(item, query, currentEventsMode)
    }))
    .filter((item) => String(item.title || "").trim());

  const filtered = currentEventsMode
    ? ranked.filter((item) => item.score >= 1 && !isLowQualitySource(item))
    : ranked.filter((item) => item.score >= -2);

  const rankedPool = currentEventsMode ? filtered : filtered.length > 0 ? filtered : ranked;

  const finalList = rankedPool
    .sort((left, right) => right.score - left.score)
    .slice(0, 6)
    .map(({ score, ...rest }) => rest);

  return finalList;
}

function parseInstantApiResult(data) {
  const abstractText = typeof data?.AbstractText === "string" ? data.AbstractText.trim() : "";
  const answer = typeof data?.Answer === "string" ? data.Answer.trim() : "";
  const relatedTopics = flattenRelatedTopics(data?.RelatedTopics, 6);
  const summary = abstractText || answer || "No direct summary found.";

  return {
    summary,
    relatedTopics,
    sources: []
  };
}

function parseWikipediaSearchResult(data) {
  const entries = Array.isArray(data && data.query && data.query.search) ? data.query.search : [];
  const first = entries[0] || null;
  if (!first) {
    return {
      summary: "No direct summary found.",
      relatedTopics: [],
      sources: []
    };
  }

  const title = String(first.title || "").trim();
  const snippet = stripHtml(first.snippet || "").trim();
  const pageId = Number(first.pageid);
  const url = Number.isFinite(pageId) ? `https://en.wikipedia.org/?curid=${pageId}` : "";
  const summary = snippet || title || "No direct summary found.";

  return {
    summary,
    relatedTopics: title ? [title] : [],
    sources: title
      ? [
          {
            title,
            url: url || "https://en.wikipedia.org/",
            snippet,
            source: "Wikipedia"
          }
        ]
      : []
  };
}

async function searchDuckDuckGoInstant(query) {
  const url = `${DUCKDUCKGO_API_URL}?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`;
  const response = await fetchWithRetry(
    url,
    {
      method: "GET",
      headers: {
        Accept: "application/json"
      }
    },
    { timeoutMs: 8000, retries: 2, baseDelayMs: 300, label: "duckduckgo:instant" }
  );

  if (!response.ok) {
    throw new Error(`DuckDuckGo API error (${response.status})`);
  }

  const data = await response.json();
  return parseInstantApiResult(data);
}

async function searchWikipedia(query) {
  const url = `${WIKIPEDIA_API_URL}?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=1&format=json&origin=*`;
  const response = await fetchWithRetry(
    url,
    {
      method: "GET",
      headers: {
        Accept: "application/json"
      }
    },
    { timeoutMs: 8000, retries: 2, baseDelayMs: 300, label: "wikipedia:search" }
  );

  if (!response.ok) {
    throw new Error(`Wikipedia API error (${response.status})`);
  }

  const data = await response.json();
  return parseWikipediaSearchResult(data);
}

async function searchGoogleNewsRss(query) {
  const q = encodeURIComponent(String(query || "").trim());
  const url = `${GOOGLE_NEWS_RSS_SEARCH_URL}?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  const response = await fetchWithRetry(
    url,
    {
      method: "GET",
      headers: {
        Accept: "application/rss+xml, application/xml, text/xml"
      }
    },
    { timeoutMs: 8000, retries: 2, baseDelayMs: 300, label: "google-news:rss-search" }
  );

  if (!response.ok) {
    throw new Error(`Google News RSS error (${response.status})`);
  }

  const xml = await response.text();
  const parsed = parseRssItems(xml, "Google News");
  return {
    summary: buildHeadlineSummary(parsed),
    relatedTopics: parsed.map((item) => item.title).slice(0, 6),
    sources: parsed.slice(0, 8)
  };
}

async function searchGoogleNewsTop() {
  const response = await fetchWithRetry(
    `${GOOGLE_NEWS_RSS_TOP_URL}?hl=en-US&gl=US&ceid=US:en`,
    {
      method: "GET",
      headers: {
        Accept: "application/rss+xml, application/xml, text/xml"
      }
    },
    { timeoutMs: 8000, retries: 1, baseDelayMs: 250, label: "google-news:rss-top" }
  );

  if (!response.ok) {
    throw new Error(`Google News Top RSS error (${response.status})`);
  }

  const xml = await response.text();
  const parsed = parseRssItems(xml, "Google News");
  return {
    summary: buildHeadlineSummary(parsed),
    relatedTopics: parsed.map((item) => item.title).slice(0, 6),
    sources: parsed.slice(0, 8)
  };
}

function verifyResultRelevance(query, result, options = {}) {
  const minScore = Number.isFinite(Number(options.minScore)) ? Number(options.minScore) : 1;
  const summary = String(result && result.summary ? result.summary : "");
  const related = Array.isArray(result && result.relatedTopics)
    ? result.relatedTopics.join(" ")
    : "";
  const sourceTitles = Array.isArray(result && result.sources)
    ? result.sources.map((item) => String(item && item.title ? item.title : "")).join(" ")
    : "";
  const bag = `${summary} ${related} ${sourceTitles}`.trim();
  if (!bag) {
    return false;
  }

  return getTokenOverlapScore(query, bag) >= minScore;
}

async function searchTrustedCurrentEventsFeeds() {
  const allItems = [];

  for (const feed of TRUSTED_WORLD_NEWS_FEEDS) {
    try {
      const response = await fetchWithRetry(
        feed.url,
        {
          method: "GET",
          headers: {
            Accept: "application/rss+xml, application/xml, text/xml"
          }
        },
        { timeoutMs: 8000, retries: 1, baseDelayMs: 250, label: `rss:${feed.source}` }
      );

      if (!response.ok) {
        continue;
      }

      const xml = await response.text();
      const parsed = parseRssItems(xml, feed.source);
      if (parsed.length > 0) {
        allItems.push(...parsed.slice(0, 3));
      }
    } catch (_error) {
      // best effort
    }
  }

  const deduped = [];
  const seen = new Set();
  allItems.forEach((item) => {
    const key = String(item.url || "").trim().toLowerCase();
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    deduped.push(item);
  });

  return {
    summary: buildHeadlineSummary(deduped),
    relatedTopics: deduped.map((item) => item.title).slice(0, 6),
    sources: deduped.slice(0, 8)
  };
}

function parseHtmlSearchResults(html, query, options = {}) {
  const currentEventsMode = Boolean(options.currentEventsMode);
  const titleMatches = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .slice(0, 6)
    .map((match) => ({
      url: unwrapDuckDuckGoRedirect(toAbsoluteDuckDuckGoLink(match[1])),
      title: stripHtml(match[2])
    }))
    .filter((item) => item.title);

  const snippetMatches = [...html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)]
    .slice(0, 6)
    .map((match) => stripHtml(match[1]));

  const rawSources = titleMatches.map((item, index) => ({
    title: item.title,
    url: item.url,
    snippet: snippetMatches[index] || ""
  }));

  const sources = rankAndFilterSources(rawSources, query, currentEventsMode);

  const nonEmptySnippets = sources
    .map((item) => String(item.snippet || "").trim())
    .filter(Boolean)
    .slice(0, 4);
  const summary = nonEmptySnippets.length > 0 ? nonEmptySnippets.join("\n") : "No direct summary found.";
  const relatedTopics = sources.map((item) => item.title).slice(0, 6);

  return {
    summary,
    relatedTopics,
    sources
  };
}

async function searchDuckDuckGoHtml(query) {
  const url = `${DUCKDUCKGO_HTML_URL}?q=${encodeURIComponent(query)}`;
  const response = await fetchWithRetry(
    url,
    {
      method: "GET",
      headers: {
        Accept: "text/html",
        "User-Agent": "Mozilla/5.0"
      }
    },
    { timeoutMs: 8000, retries: 2, baseDelayMs: 300, label: "duckduckgo:html" }
  );

  if (!response.ok) {
    throw new Error(`DuckDuckGo HTML search error (${response.status})`);
  }

  const html = await response.text();
  return parseHtmlSearchResults(html, query, {
    currentEventsMode: isCurrentEventsQuery(query)
  });
}

async function searchWeb(query) {
  const safeQuery = String(query || "").trim();

  if (!safeQuery) {
    return {
      summary: "",
      relatedTopics: [],
      sources: []
    };
  }

  const candidates = buildCandidateQueries(safeQuery);
  const currentEventsMode = isCurrentEventsQuery(safeQuery);
  const searchIntent = classifySearchIntent(safeQuery);

  if (searchIntent === "latest_news") {
    for (const candidate of candidates) {
      try {
        const googleNewsRaw = await searchGoogleNewsRss(candidate);
        const googleNews = filterNewsResultByQuery(safeQuery, googleNewsRaw);
        if (
          Array.isArray(googleNews.sources) &&
          googleNews.sources.length > 0 &&
          verifyResultRelevance(safeQuery, googleNews, { minScore: 0 })
        ) {
          return googleNews;
        }
      } catch (_error) {
        // Try next candidate/fallback.
      }
    }

    try {
      const topNewsRaw = await searchGoogleNewsTop();
      const topNews = filterNewsResultByQuery(safeQuery, topNewsRaw);
      if (Array.isArray(topNews.sources) && topNews.sources.length > 0) {
        return topNews;
      }
    } catch (_error) {
      // continue fallback chain
    }

    const rssResult = await searchTrustedCurrentEventsFeeds();
    if (Array.isArray(rssResult.sources) && rssResult.sources.length > 0) {
      return rssResult;
    }
  }

  if (searchIntent === "knowledge") {
    for (const candidate of candidates) {
      try {
        const wiki = await searchWikipedia(candidate);
        if (
          Array.isArray(wiki.sources) &&
          wiki.sources.length > 0 &&
          verifyResultRelevance(safeQuery, wiki, { minScore: 1 })
        ) {
          return wiki;
        }
      } catch (_error) {
        // Try fallback path.
      }
    }
  }

  let fallback = {
    summary: "No direct summary found.",
    relatedTopics: [],
    sources: []
  };

  if (currentEventsMode) {
    fallback = {
      summary:
        "Reliable current-events sources nahi mile. Query ko thoda specific karein (topic/country/time) for better results.",
      relatedTopics: [],
      sources: []
    };
  }

  if (!currentEventsMode) {
    for (const candidate of candidates) {
      const instantResult = await searchDuckDuckGoInstant(candidate);
      const isRelevant = verifyResultRelevance(safeQuery, instantResult, { minScore: 1 });
      if ((hasUsefulSummary(instantResult.summary) || instantResult.relatedTopics.length > 0) && isRelevant) {
        return instantResult;
      }
      fallback = instantResult;
    }
  }

  for (const candidate of candidates) {
    try {
      const htmlResult = await searchDuckDuckGoHtml(candidate);
      const hasUsableHtml =
        (hasUsefulSummary(htmlResult.summary) || htmlResult.relatedTopics.length > 0) &&
        (!currentEventsMode || (Array.isArray(htmlResult.sources) && htmlResult.sources.length > 0));
      if (hasUsableHtml) {
        return htmlResult;
      }
      if (!currentEventsMode) {
        fallback = htmlResult;
      }
    } catch (_error) {
      // Keep best-effort behavior and fall back to previous result.
    }
  }

  return fallback;
}

module.exports = {
  searchWeb
};
