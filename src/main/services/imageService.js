const { getEnv, getEnvFileHint } = require("../config/env");

const DEFAULT_MODEL = String(process.env.OPENAI_IMAGE_MODEL || "gpt-image-1").trim();
const DEFAULT_SIZE = String(process.env.OPENAI_IMAGE_SIZE || "1024x1024").trim();
const GPT_IMAGE_SIZES = new Set(["1024x1024", "1536x1024", "1024x1536", "auto"]);
const DALL_E_3_SIZES = new Set(["1024x1024", "1792x1024", "1024x1792"]);
const DALL_E_2_SIZES = new Set(["256x256", "512x512", "1024x1024"]);
const ALLOWED_COUNTS = new Set([1, 2, 4]);

function isLikelyOpenAIKey(value) {
  const trimmed = String(value || "").trim();
  return trimmed.startsWith("sk-") && trimmed.length >= 16;
}

function getOpenAIKey() {
  const env = getEnv();
  const primaryKey = String(env.OPENAI_API_KEY || "").trim();
  if (isLikelyOpenAIKey(primaryKey)) {
    return primaryKey;
  }
  return "";
}

function normalizePrompt(prompt) {
  return String(prompt || "").replace(/\s+/g, " ").trim();
}

function enhancePrompt(prompt) {
  const base = normalizePrompt(prompt);
  if (!base) {
    return "";
  }
  return `${base}. Keep visuals clear, topic-accurate, and educational.`;
}

function buildUniversalImagePrompt(prompt, imageTypeValue) {
  const base = normalizePrompt(prompt);
  if (!base) {
    return "";
  }

  const imageType = String(imageTypeValue || "auto").trim().toLowerCase();
  const constraints = [
    "STRICT: Match the requested topic exactly.",
    "STRICT: Do not generate unrelated symbolic or random visuals.",
    "Style: clean, minimal, labeled, educational."
  ];

  if (imageType === "flowchart") {
    constraints.push("Use a step-by-step flowchart with arrows and labeled nodes.");
  } else if (imageType === "comparison") {
    constraints.push("Use a side-by-side comparison infographic with clear labels.");
  } else if (imageType === "realistic") {
    constraints.push("Use a realistic visual but keep topic labels clear and accurate.");
  } else {
    constraints.push("Use a clear explanatory diagram with labeled parts.");
  }

  return `${base}\n\n${constraints.join(" ")}`;
}

function resolveSize(value, modelName) {
  const candidate = String(value || "").trim();
  const model = String(modelName || "").toLowerCase();
  const allowed =
    model.includes("dall-e-3") ? DALL_E_3_SIZES : model.includes("dall-e-2") ? DALL_E_2_SIZES : GPT_IMAGE_SIZES;
  if (allowed.has(candidate)) {
    return candidate;
  }
  if (allowed.has(DEFAULT_SIZE)) {
    return DEFAULT_SIZE;
  }
  return allowed.has("1024x1024") ? "1024x1024" : "auto";
}

function resolveCount(value) {
  const num = Number(value);
  if (Number.isFinite(num) && ALLOWED_COUNTS.has(num)) {
    return num;
  }
  return 1;
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) {
    return { json: null, raw: "" };
  }

  try {
    return { json: JSON.parse(text), raw: text };
  } catch (_error) {
    return { json: null, raw: text };
  }
}

function extractImageUrl(payload) {
  const data = Array.isArray(payload && payload.data) ? payload.data[0] : null;
  if (data && data.url) {
    return String(data.url);
  }
  if (data && data.b64_json) {
    const cleaned = String(data.b64_json || "").replace(/\s+/g, "");
    return cleaned ? `data:image/png;base64,${cleaned}` : "";
  }
  return "";
}

function extractImageUrls(payload) {
  const data = Array.isArray(payload && payload.data) ? payload.data : [];
  const urls = [];
  data.forEach((item) => {
    if (item && item.url) {
      urls.push(String(item.url));
    } else if (item && item.b64_json) {
      const cleaned = String(item.b64_json || "").replace(/\s+/g, "");
      if (cleaned) {
        urls.push(`data:image/png;base64,${cleaned}`);
      }
    }
  });
  if (urls.length === 0) {
    const single = extractImageUrl(payload);
    if (single) {
      urls.push(single);
    }
  }
  return urls;
}

function createImageService(options = {}) {
  const metrics = options.metrics;

  async function generateImage(prompt, optionsArg = {}) {
    const apiKey = getOpenAIKey();
    if (!apiKey) {
      throw new Error(`OPENAI_API_KEY is missing. Add it in: ${getEnvFileHint()}`);
    }

    const model = String(optionsArg.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    const size = resolveSize(optionsArg.size, model);
    const count = resolveCount(optionsArg.count ?? optionsArg.n);
    const enhance = Boolean(
      typeof optionsArg.enhance === "boolean"
        ? optionsArg.enhance
        : String(process.env.OPENAI_IMAGE_ENHANCE || "").toLowerCase() === "true"
    );
    const basePrompt = normalizePrompt(prompt);
    if (!basePrompt) {
      throw new Error("Image prompt is empty");
    }
    const finalPrompt = enhance ? enhancePrompt(basePrompt) : basePrompt;
    const promptWithGuardrails = buildUniversalImagePrompt(finalPrompt, optionsArg.imageType);

    const body = {
      model,
      prompt: promptWithGuardrails,
      size,
      n: count
    };
    if (model.includes("dall-e")) {
      body.response_format = "url";
    }

    const start = Date.now();
    let response = null;
    try {
      response = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
      });
    } catch (error) {
      const latency = Date.now() - start;
      if (metrics && typeof metrics.recordLLMCall === "function") {
        try {
          metrics.recordLLMCall(model, latency, "openai-image", false);
        } catch (_error) {}
      }
      throw error;
    }

    const { json, raw } = await parseResponseBody(response);
    const latency = Date.now() - start;
    if (metrics && typeof metrics.recordLLMCall === "function") {
      try {
        metrics.recordLLMCall(model, latency, "openai-image", response.ok);
      } catch (_error) {}
    }

    if (!response.ok) {
      const detail = raw || JSON.stringify(json || {});
      throw new Error(detail || "Image generation failed");
    }

    const urls = extractImageUrls(json);
    if (urls.length === 0) {
      throw new Error("No image URL returned");
    }

    return {
      url: urls[0],
      urls,
      images: urls.map((url) => ({ url })),
      prompt: finalPrompt,
      guardedPrompt: promptWithGuardrails,
      model,
      size,
      count
    };
  }

  return { generateImage };
}

module.exports = { createImageService };
