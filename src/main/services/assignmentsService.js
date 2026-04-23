const { fetchWithRetry } = require("../httpClient");
const { getEnv } = require("../config/env");

function normalizeText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function guessDocType(item) {
  const explicit = String(item && item.documentType ? item.documentType : "").trim().toLowerCase();
  if (explicit) return explicit;
  const url = String(item && item.documentUrl ? item.documentUrl : "").trim().toLowerCase();
  if (url.endsWith(".docx") || url.includes(".docx?")) return "word";
  if (url.endsWith(".doc") || url.includes(".doc?")) return "word";
  if (url.endsWith(".pdf") || url.includes(".pdf?")) return "pdf";
  return "";
}

function safeJoinUrl(base, path) {
  const safeBase = String(base || "").trim().replace(/\/+$/, "");
  const safePath = String(path || "").trim().replace(/^\/+/, "");
  if (!safeBase) return safePath;
  if (!safePath) return safeBase;
  return `${safeBase}/${safePath}`;
}

function stripXmlToText(xml) {
  const source = String(xml || "");
  if (!source) return "";

  // Capture Word text nodes. Word sometimes nests other tags inside runs, so only take plain-text segments.
  const chunks = [];
  const re = /<w:t[^>]*>([^<]*)<\/w:t>/g;
  let match = null;
  while ((match = re.exec(source))) {
    chunks.push(match[1]);
  }

  const joined = chunks
    .join(" ")
    // minimal entity decode
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");

  return joined
    .replace(/\r/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function extractDocxText(buffer) {
  if (!buffer || buffer.length === 0) return "";
  let JSZip = null;
  try {
    // exceljs brings jszip transitively; prefer not adding a new dependency.
    // eslint-disable-next-line global-require
    JSZip = require("jszip");
  } catch (_error) {
    JSZip = null;
  }

  if (!JSZip) {
    return "";
  }

  try {
    const zip = await JSZip.loadAsync(buffer);
    const doc = zip.file("word/document.xml");
    if (!doc) return "";
    const xml = await doc.async("string");
    return stripXmlToText(xml);
  } catch (_error) {
    return "";
  }
}

function scoreAssignment(item, query) {
  const q = normalizeText(query);
  if (!q) return 0;

  const topic = normalizeText(item && item.topicName);
  const docUrl = normalizeText(item && item.documentUrl);
  const course = Array.isArray(item && item.course) ? item.course : [];
  const courseTitles = course.map((c) => normalizeText(c && c.title)).filter(Boolean);
  const courseCodes = course.map((c) => normalizeText(c && c.code)).filter(Boolean);

  let score = 0;

  // High weight for topic match.
  if (topic && topic.includes(q)) score += 12;
  if (topic && q.includes(topic) && topic.length > 4) score += 7;

  // Medium weight for course title/code match.
  courseTitles.forEach((t) => {
    if (t && t.includes(q)) score += 8;
  });
  courseCodes.forEach((c) => {
    if (c && c.includes(q)) score += 9;
  });

  // Light weight for URL match (rare but useful).
  if (docUrl && docUrl.includes(q)) score += 2;

  // Token-wise partial matching.
  const tokens = q.split(" ").filter((t) => t.length >= 3).slice(0, 8);
  tokens.forEach((t) => {
    if (topic.includes(t)) score += 1.4;
    courseTitles.forEach((ct) => {
      if (ct.includes(t)) score += 0.9;
    });
    courseCodes.forEach((cc) => {
      if (cc.includes(t)) score += 1.0;
    });
  });

  return score;
}

function createAssignmentsService() {
  let cache = {
    fetchedAt: 0,
    total: 0,
    items: []
  };
  const docCache = new Map(); // url -> { fetchedAt, text }

  const CACHE_TTL_MS = 2 * 60 * 1000;
  const DOC_TTL_MS = 10 * 60 * 1000;

  function getConfig() {
    const env = getEnv();
    const base = String(env.ASSIGNMENTS_API_BASE || "").trim();
    const token = String(env.ASSIGNMENTS_MASTER_TOKEN || "").trim();
    return { base, token };
  }

  function isConfigured() {
    const { base, token } = getConfig();
    return Boolean(base && token);
  }

  async function fetchAssignmentsPage(page = 1, limit = 50) {
    const { base, token } = getConfig();
    if (!base) throw new Error("ASSIGNMENTS_API_BASE missing");
    if (!token) throw new Error("ASSIGNMENTS_MASTER_TOKEN missing");

    const url = `${safeJoinUrl(base, "admin/all")}?page=${encodeURIComponent(page)}&limit=${encodeURIComponent(limit)}`;
    const response = await fetchWithRetry(
      url,
      {
        method: "GET",
        headers: {
          "x-master-token": token
        }
      },
      { label: "assignments", timeoutMs: 12000, retries: 1 }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Assignments API error (${response.status}): ${text || response.statusText}`);
    }

    const json = await response.json();
    const items = Array.isArray(json && json.items) ? json.items : [];
    return {
      page: Number(json && json.page ? json.page : page),
      limit: Number(json && json.limit ? json.limit : limit),
      total: Number(json && json.total ? json.total : items.length),
      items
    };
  }

  async function ensureCacheWarm() {
    const now = Date.now();
    if (cache.items.length && now - cache.fetchedAt < CACHE_TTL_MS) {
      return cache;
    }

    // Fetch first page and then fetch remaining pages (capped).
    const first = await fetchAssignmentsPage(1, 50);
    const total = first.total || first.items.length;
    const pages = Math.ceil(total / first.limit);
    const maxPages = Math.min(pages, 8); // hard cap: 8*50=400

    const all = [...first.items];
    for (let p = 2; p <= maxPages; p += 1) {
      // eslint-disable-next-line no-await-in-loop
      const next = await fetchAssignmentsPage(p, first.limit);
      all.push(...(next.items || []));
    }

    cache = {
      fetchedAt: now,
      total,
      items: all
    };
    return cache;
  }

  async function fetchAssignmentDocumentText(item) {
    const url = String(item && item.documentUrl ? item.documentUrl : "").trim();
    if (!url) return "";

    const now = Date.now();
    const existing = docCache.get(url);
    if (existing && existing.text && now - existing.fetchedAt < DOC_TTL_MS) {
      return existing.text;
    }

    const type = guessDocType(item);
    if (type !== "word") {
      // Only docx/doc supported for now.
      docCache.set(url, { fetchedAt: now, text: "" });
      return "";
    }

    try {
      const response = await fetchWithRetry(
        url,
        {
          method: "GET",
          headers: {
            "user-agent": "IFDA-AI/1.0 (+assignments-doc-reader)"
          }
        },
        { label: "assignmentDoc", timeoutMs: 20000, retries: 1 }
      );

      if (!response.ok) {
        docCache.set(url, { fetchedAt: now, text: "" });
        return "";
      }

      const arrayBuffer = await response.arrayBuffer();
      const buf = Buffer.from(arrayBuffer);
      const text = await extractDocxText(buf);
      const trimmed = String(text || "").trim();
      const limited = trimmed.length > 12000 ? `${trimmed.slice(0, 11997)}...` : trimmed;
      docCache.set(url, { fetchedAt: now, text: limited });
      return limited;
    } catch (_error) {
      docCache.set(url, { fetchedAt: now, text: "" });
      return "";
    }
  }

  async function searchAssignments(query, options = {}) {
    const limit = Number.isFinite(Number(options.limit)) ? Number(options.limit) : 6;
    const safeQuery = String(query || "").trim();
    if (!safeQuery) {
      return { matches: [], total: 0 };
    }

    const snapshot = await ensureCacheWarm();
    const scored = (snapshot.items || [])
      .map((item) => ({ item, score: scoreAssignment(item, safeQuery) }))
      .filter((row) => row.score > 0.9)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit));

    const matches = scored.map((row) => row.item);

    if (options.includeDocumentText) {
      const hydrated = [];
      for (const match of matches) {
        // eslint-disable-next-line no-await-in-loop
        const text = await fetchAssignmentDocumentText(match);
        hydrated.push({ ...match, documentText: text });
      }
      return { matches: hydrated, total: snapshot.total || snapshot.items.length };
    }

    return { matches, total: snapshot.total || snapshot.items.length };
  }

  return {
    isConfigured,
    fetchAssignmentsPage,
    fetchAssignmentDocumentText,
    searchAssignments
  };
}

module.exports = { createAssignmentsService };
