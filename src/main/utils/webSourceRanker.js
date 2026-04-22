function safeUrl(value) {
  const url = String(value || "").trim();
  if (!/^https?:\/\//i.test(url)) return "";
  return url;
}

function stripTrackingParams(url) {
  const safe = safeUrl(url);
  if (!safe) return "";

  try {
    const parsed = new URL(safe);
    const keysToDrop = [];
    parsed.searchParams.forEach((_value, key) => {
      const k = String(key || "").toLowerCase();
      if (k.startsWith("utm_")) keysToDrop.push(key);
      if (k === "gclid" || k === "fbclid") keysToDrop.push(key);
      if (k === "ref" || k === "ref_src" || k === "ref_url") keysToDrop.push(key);
      if (k === "source" && parsed.searchParams.get(key) === "openai") keysToDrop.push(key);
      if (k === "utm_source" && parsed.searchParams.get(key) === "openai") keysToDrop.push(key);
    });
    keysToDrop.forEach((key) => parsed.searchParams.delete(key));
    return parsed.toString();
  } catch (_error) {
    return safe;
  }
}

function getHostname(url) {
  const safe = safeUrl(url);
  if (!safe) return "";
  try {
    return new URL(safe).hostname.replace(/^www\./i, "").toLowerCase();
  } catch (_error) {
    return "";
  }
}

function matchesAny(hostname, patterns) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return false;
  return (patterns || []).some((pattern) => {
    if (!pattern) return false;
    if (pattern instanceof RegExp) return pattern.test(host);
    const needle = String(pattern).toLowerCase();
    return host === needle || host.endsWith(`.${needle}`);
  });
}

const TRUSTED_HOST_PATTERNS = [
  // Official / reference
  "openai.com",
  "anthropic.com",
  "google.com",
  "deepmind.com",
  "microsoft.com",
  "github.com",
  "arxiv.org",
  "wikipedia.org",
  "docs.google.com",
  "developer.mozilla.org",
  // High-quality news / tech
  "reuters.com",
  "apnews.com",
  "bbc.co.uk",
  "bbc.com",
  "wsj.com",
  "ft.com",
  "theverge.com",
  "techcrunch.com",
  "wired.com",
  "nature.com",
  "science.org"
];

const LOW_QUALITY_HOST_PATTERNS = [
  /blogspot\./i,
  /wordpress\./i,
  /medium\.com$/i,
  /substack\.com$/i,
  /\.pages\.dev$/i,
  /\.vercel\.app$/i,
  /\.weebly\.com$/i,
  /\.wixsite\.com$/i,
  /\.myshopify\.com$/i
];

function scoreSource(source) {
  const url = safeUrl(source && source.url ? source.url : "");
  const hostname = getHostname(url);
  if (!url || !hostname) return -999;

  let score = 0;
  if (/^https:\/\//i.test(url)) score += 1;
  if (matchesAny(hostname, TRUSTED_HOST_PATTERNS)) score += 6;
  if (matchesAny(hostname, LOW_QUALITY_HOST_PATTERNS)) score -= 3;

  // Prefer cleaner URLs (less tracking/noise).
  const stripped = stripTrackingParams(url);
  if (stripped && stripped.length < url.length) score += 1;

  // Prefer sources with meaningful title/snippet.
  const title = String(source && source.title ? source.title : "").trim();
  const snippet = String(source && source.snippet ? source.snippet : "").trim();
  if (title.length >= 12) score += 1;
  if (snippet.length >= 40) score += 1;

  return score;
}

function rankAndFilterWebSources(sources, options = {}) {
  const max = Number.isFinite(Number(options.max)) ? Number(options.max) : 6;
  const preferTrusted = options.preferTrusted !== false;

  const normalized = (Array.isArray(sources) ? sources : [])
    .map((src) => {
      if (!src || typeof src !== "object") return null;
      const urlRaw = safeUrl(src.url);
      if (!urlRaw) return null;
      const url = stripTrackingParams(urlRaw) || urlRaw;
      return {
        title: String(src.title || url).trim(),
        url,
        snippet: String(src.snippet || "").trim()
      };
    })
    .filter(Boolean);

  const deduped = [];
  const seen = new Set();
  normalized.forEach((src) => {
    const key = String(src.url || "").toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    deduped.push(src);
  });

  const scored = deduped
    .map((src) => ({ ...src, _score: scoreSource(src), _host: getHostname(src.url) }))
    .filter((src) => src._score > -999);

  const hasTrusted = scored.some((src) => matchesAny(src._host, TRUSTED_HOST_PATTERNS));
  const filtered = preferTrusted && hasTrusted
    ? scored.filter((src) => src._score >= 2) // drop obvious low-quality when trusted exists
    : scored;

  filtered.sort((a, b) => (b._score - a._score) || String(a.title).localeCompare(String(b.title)));

  return filtered.slice(0, max).map(({ _score, _host, ...rest }) => rest);
}

module.exports = {
  rankAndFilterWebSources,
  stripTrackingParams
};

