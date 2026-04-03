const METRICS_BUFFER = [];

function emit(entry) {
  const payload = { ts: Date.now(), ...entry };
  METRICS_BUFFER.push(payload);
  // immediate structured log for visibility
  try {
    console.log("[metrics]", JSON.stringify(payload));
  } catch (_e) {}
}

function recordTokenUsage(totalTokens, trimmedTokens, model) {
  emit({ type: "token", total: totalTokens, trimmed: trimmedTokens, model: model || "unknown" });
}

function recordCacheHit(cacheType, key) {
  emit({ type: "cache", event: "hit", cacheType: cacheType || "generic", keyPreview: String(key || "").slice(0, 200) });
}

function recordCacheMiss(cacheType, key) {
  emit({ type: "cache", event: "miss", cacheType: cacheType || "generic", keyPreview: String(key || "").slice(0, 200) });
}

function recordSanitizer(source, modified, details) {
  emit({ type: "sanitizer", source: source || "unknown", modified: Boolean(modified), details: details || {} });
}

function recordLLMCall(model, latencyMs, provider, success) {
  emit({ type: "llm_call", model: model || "unknown", provider: provider || "unknown", latencyMs: Number(latencyMs || 0), success: Boolean(success) });
}

function recordTiming(name, ms, meta) {
  emit({ type: "timing", name, ms: Number(ms || 0), meta: meta || {} });
}

module.exports = {
  recordTokenUsage,
  recordCacheHit,
  recordCacheMiss,
  recordSanitizer,
  recordLLMCall,
  recordTiming
};
