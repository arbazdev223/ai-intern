const DEFAULT_MAX_RETRIES = Number.isFinite(Number(process.env.CONTROL_MAX_RETRIES))
  ? Number(process.env.CONTROL_MAX_RETRIES)
  : 2;
const DEFAULT_BACKOFF_MS = Number.isFinite(Number(process.env.CONTROL_BASE_BACKOFF_MS))
  ? Number(process.env.CONTROL_BASE_BACKOFF_MS)
  : 500;
const DEFAULT_CACHE_TTL_MS = Number.isFinite(Number(process.env.RESPONSE_CACHE_TTL_MS))
  ? Number(process.env.RESPONSE_CACHE_TTL_MS)
  : 1000 * 60 * 20;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUserPromptForCache(input) {
  return String(input || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function buildCacheKey(promptKey, intentKey) {
  return `${intentKey}:${promptKey}`;
}

function resolveSystemPrompt(_inputType, overridePrompt) {
  if (typeof overridePrompt === "string") {
    return overridePrompt.trim();
  }
  return "";
}

async function callProvider(options) {
  const {
    modelService,
    provider,
    modelName,
    promptText,
    screenshotBase64,
    metrics,
    inputType,
    systemPrompt
  } = options;

  const start = Date.now();
  try {
    let content = "";
    const resolvedSystemPrompt = resolveSystemPrompt(inputType, systemPrompt);
    if (screenshotBase64) {
      const combinedPrompt = resolvedSystemPrompt
        ? `${resolvedSystemPrompt}\n\n${promptText}`
        : promptText;
      if (provider === "openai") {
        content = await modelService.callOpenAIVision({
          model: modelName,
          promptText: combinedPrompt,
          screenshotBase64
        });
      } else {
        content = await modelService.callGeminiVision(combinedPrompt, screenshotBase64);
      }
    } else if (provider === "openai") {
      const messages = resolvedSystemPrompt
        ? [
            { role: "system", content: resolvedSystemPrompt },
            { role: "user", content: promptText }
          ]
        : [{ role: "user", content: promptText }];
      content = await modelService.callOpenAIChat({
        model: modelName,
        messages,
        temperature: 0.2
      });
    } else {
      const combinedPrompt = resolvedSystemPrompt
        ? `${resolvedSystemPrompt}\n\n${promptText}`
        : promptText;
      content = await modelService.callGeminiText(combinedPrompt);
    }

    const latency = Date.now() - start;
    if (metrics && typeof metrics.recordLLMCall === "function") {
      try {
        metrics.recordLLMCall(modelName, latency, provider, true);
      } catch (_error) {}
    }

    return { success: true, content, usedModel: `${provider}:${modelName}`, provider };
  } catch (error) {
    const latency = Date.now() - start;
    if (metrics && typeof metrics.recordLLMCall === "function") {
      try {
        metrics.recordLLMCall(modelName, latency, provider, false);
      } catch (_error) {}
    }
    return { success: false, error };
  }
}

function createControlService({ modelService, metrics, responseCache, responseCacheTTL }) {
  async function request(options = {}) {
    const {
      finalPrompt,
      screenshotBase64,
      userPrompt,
      intentKey,
      inputType,
      systemPrompt,
      openAIEnabled,
      geminiEnabled
    } = options;

    const promptKey = normalizeUserPromptForCache(userPrompt);
    const intentSig = String(intentKey || "").trim().toLowerCase();
    const cacheKey = buildCacheKey(promptKey, intentSig);
    const ttlMs = Number.isFinite(Number(responseCacheTTL))
      ? Number(responseCacheTTL)
      : DEFAULT_CACHE_TTL_MS;

    if (responseCache && promptKey && intentSig) {
      try {
        const cached = responseCache.get(cacheKey);
        if (
          cached &&
          cached.ts &&
          Date.now() - cached.ts < ttlMs &&
          cached.intentKey === intentSig &&
          cached.promptKey === promptKey
        ) {
          if (metrics && typeof metrics.recordCacheHit === "function") {
            try {
              metrics.recordCacheHit("response", cacheKey);
            } catch (_error) {}
          }
          return cached.value;
        }
        if (metrics && typeof metrics.recordCacheMiss === "function") {
          try {
            metrics.recordCacheMiss("response", cacheKey);
          } catch (_error) {}
        }
      } catch (_error) {}
    }

    const providers = [];
    if (openAIEnabled) {
      providers.push({ provider: "openai", model: modelService.getOpenAIModel() });
    }
    if (geminiEnabled) {
      providers.push({ provider: "gemini", model: modelService.getGeminiModel() });
    }

    if (providers.length === 0) {
      throw new Error("No provider configured");
    }

    for (const candidate of providers) {
      let attempt = 0;
      while (attempt <= DEFAULT_MAX_RETRIES) {
        if (attempt > 0) {
          const delay = DEFAULT_BACKOFF_MS * Math.pow(2, attempt - 1);
          await sleep(delay);
        }

        const res = await callProvider({
          modelService,
          provider: candidate.provider,
          modelName: candidate.model,
          promptText: finalPrompt,
          screenshotBase64,
          metrics,
          inputType,
          systemPrompt
        });

        if (res.success) {
          const responsePayload = {
            response: res.content,
            usedModel: res.usedModel || `${candidate.provider}:${candidate.model}`,
            provider: candidate.provider
          };

          if (responseCache && promptKey && intentSig) {
            try {
              responseCache.set(cacheKey, {
                value: responsePayload,
                ts: Date.now(),
                intentKey: intentSig,
                promptKey
              });
            } catch (_error) {}
          }

          return responsePayload;
        }

        attempt += 1;
        if (attempt > DEFAULT_MAX_RETRIES) {
          break;
        }
      }
    }

    throw new Error("All model attempts failed");
  }

  return { request };
}

module.exports = { createControlService };
