const { fetchWithRetry } = require("../httpClient");

function normalizeUrl(value) {
  const safe = String(value || "").trim();
  if (!safe) return "";
  if (!/^https?:\/\//i.test(safe)) return "";
  return safe;
}

function extractFirstUrl(text) {
  const source = String(text || "");
  const match = source.match(/https?:\/\/[^\s)\]}>"']+/i);
  return match ? normalizeUrl(match[0]) : "";
}

function stripHtmlToText(html) {
  const source = String(html || "");
  if (!source) return "";

  // Remove scripts/styles.
  let cleaned = source
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ");

  // Convert common block separators to newlines.
  cleaned = cleaned
    .replace(/<\/(p|div|section|article|main|header|footer|li|h\d|br)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");

  // Drop remaining tags.
  cleaned = cleaned.replace(/<[^>]+>/g, " ");

  // Decode a small subset of entities.
  cleaned = cleaned
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");

  // Normalize whitespace.
  cleaned = cleaned
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return cleaned;
}

function extractTitle(html) {
  const source = String(html || "");
  const match = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? String(match[1] || "").replace(/\s+/g, " ").trim() : "";
}

function createLinkReaderService() {
  async function fetchUrlText(url) {
    const safeUrl = normalizeUrl(url);
    if (!safeUrl) throw new Error("Invalid URL");

    const response = await fetchWithRetry(
      safeUrl,
      {
        method: "GET",
        headers: {
          "user-agent": "IFDA-AI/1.0 (+link-reader)"
        }
      },
      { label: "linkReader", timeoutMs: 15000, retries: 1 }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Link fetch failed (${response.status}): ${text || response.statusText}`);
    }

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const raw = await response.text();

    if (raw.length > 350_000) {
      // Avoid huge pages overwhelming the prompt.
      // Keep the beginning, which often contains the visible content/title.
      // (Better than the tail where scripts live.)
      // eslint-disable-next-line no-param-reassign
      return {
        url: safeUrl,
        contentType,
        title: extractTitle(raw),
        text: stripHtmlToText(raw.slice(0, 350_000)),
        truncated: true
      };
    }

    return {
      url: safeUrl,
      contentType,
      title: extractTitle(raw),
      text: stripHtmlToText(raw),
      truncated: false
    };
  }

  return {
    extractFirstUrl,
    fetchUrlText
  };
}

module.exports = { createLinkReaderService };

