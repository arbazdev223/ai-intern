function createIntentService(modelService) {
  const UNIFIED_INTENTS = [
    "general",
    "explanation",
    "document_formatting",
    "web_research",
    "coding",
    "image_generation",
    "hybrid",
    "other"
  ];

  function isHybridRequest(input) {
    const text = String(input || "").trim();
    const lower = text.toLowerCase();

    if (!isExplanationRequest(text)) {
      return false;
    }

    const hasImageGenerationVerb =
      /(generate|create|make|draw|render)\s+(an?\s+)?(image|art|illustration|poster|wallpaper|logo)/i.test(lower) ||
      /(image|art|illustration|poster|wallpaper|logo)\s+(generate|create|make)/i.test(lower) ||
      /\bexplain\b\s*\+\s*\b(generate|create|make|draw|render)\b/i.test(lower);

    return hasImageGenerationVerb;
  }

  function isExplanationRequest(input) {
    const lower = String(input || "").toLowerCase();

    return (
      lower.startsWith("explain") ||
      lower.startsWith("what") ||
      lower.startsWith("how") ||
      lower.startsWith("why") ||
      lower.includes("explain ")
    );
  }

  function isImagePrompt(input) {
  const lower = String(input || "").toLowerCase();

  if (
    lower.includes("explain") ||
    lower.includes("what") ||
    lower.includes("?")
  ) {
    return false;
  }

  const keywordMatch = [
    "4k", "ultra detailed", "cinematic",
    "render", "octane", "photorealistic",
    "cyberpunk", "neon", "blade runner"
  ].some(k => lower.includes(k));

  const commaHeavy = (String(input || "").match(/,/g) || []).length >= 3;
  const noQuestion = !lower.includes("?");

  return keywordMatch || (commaHeavy && noQuestion);
  }

  function buildUnifiedIntentPrompt(userPrompt, optionsArg = {}) {
    const hasScreenshot = Boolean(optionsArg.hasScreenshot);
    const trimmed = String(userPrompt || "").trim().slice(0, 700);
    return [
      "You are an intent classifier for a professional assistant pipeline.",
      "Return ONLY JSON.",
      "",
      "{",
      "  \"intent\": \"general | document_formatting | web_research | coding | other\",",
      "  \"needs_web\": true or false,",
      "  \"needs_rag\": true or false",
      "}",
      "",
      "Rules:",
      "- Decide by user objective.",
      "- document_formatting: user asks to create/format/export documents, reports, files, templates.",
      "- web_research: user asks for latest/current/events/facts that require web evidence.",
      "- coding: user asks for code, debugging, technical implementation help.",
      "- general: normal explanatory/help requests.",
      "- other: unrelated/unclear requests.",
      "- needs_web should be true for web_research and false otherwise, unless explicitly needed.",
      "- needs_rag should be true for coding or when prior context is useful; false for standalone simple queries.",
      "- If screenshot is attached, prefer needs_rag=true.",
      "",
      `Has screenshot: ${hasScreenshot ? "yes" : "no"}`,
      "User query:",
      trimmed || "(empty)"
    ].join("\n");
  }

  function extractJsonFromText(text) {
    const source = String(text || "").trim();
    if (!source) return null;

    const candidates = [source];
    const snippetMatch = source.match(/```[\s\S]*?```/);
    if (snippetMatch) {
      const cleaned = snippetMatch[0].replace(/```[a-z]*\n?/gi, "").replace(/```/g, "");
      candidates.push(cleaned.trim());
    }

    const start = source.indexOf("{");
    const end = source.lastIndexOf("}");
    if (start !== -1 && end > start) {
      candidates.push(source.slice(start, end + 1).trim());
    }

    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate);
      } catch (_error) {}
    }

    return null;
  }

  function normalizeLabel(value, allowed, fallback) {
    const raw = String(value || "").trim().toLowerCase();
    if (allowed.includes(raw)) {
      return raw;
    }
    return fallback;
  }

  function normalizeBoolean(value, fallback = false) {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const raw = value.trim().toLowerCase();
      if (raw === "true") {
        return true;
      }
      if (raw === "false") {
        return false;
      }
    }
    return Boolean(fallback);
  }

  function detectResponseMode(userInput) {
    const text = String(userInput || "").trim();
    const shortInput = text.length < 20;
    const greeting = isGreeting(text);

    if (greeting) return "minimal";
    if (shortInput) return "short";
    return "detailed";
  }

  function isGreeting(input) {
    const text = String(input || "").toLowerCase().trim();
    return /^(hi+|hey+|hello+)$/.test(text);
  }

  function detectTone(input) {
    const text = String(input || "").toLowerCase().trim();
    const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;
    const hasQuestion = text.includes("?");
    const casualWords = ["hi", "hello", "hey", "bro", "bhai"];
    const casualSignal = casualWords.some((word) => text.includes(word));
    const shortSentence = wordCount <= 8;
    const taskSignal =
      /\b(explain|search|latest|news|today|research|analyze|architecture|code|debug|compare|generate|create|build|batao|kya|kaise|kyu)\b/i.test(text);

    if (isExplanationRequest(text)) return "formal";
    if (isGreeting(text)) return "casual";
    if (taskSignal) return "formal";

    if (casualSignal && shortSentence) return "casual";
    if (shortSentence && !hasQuestion) return "casual";
    return "formal";
  }

  function isInformalLanguage(text) {
    const source = String(text || "");
    return /[a-z]/.test(source) && source.includes(" ");
  }

  function getTone(input) {
    const tone = detectTone(input);

    if (isInformalLanguage(input) && tone === "casual") {
      return "casual";
    }

    return tone;
  }

  async function callIntentModel(promptText) {
    const openAIClient = modelService.getOpenAIClient && modelService.getOpenAIClient();
    const geminiClient = modelService.getGeminiClient && modelService.getGeminiClient();

    if (openAIClient) {
      try {
        const model = modelService.getOpenAIModel();
        return await modelService.callOpenAIChat({
          model,
          messages: [
            { role: "system", content: "Return only valid JSON." },
            { role: "user", content: promptText }
          ],
          temperature: 0
        });
      } catch (_error) {}
    }

    if (geminiClient) {
      try {
        return await modelService.callGeminiText(promptText);
      } catch (_error) {}
    }

    return "";
  }

  async function classifyIntent(userPrompt, optionsArg = {}) {
    if (isHybridRequest(userPrompt)) {
      return {
        intent: "hybrid",
        needs_web: false,
        needs_rag: false
      };
    }

    if (isExplanationRequest(userPrompt)) {
      return {
        intent: "explanation",
        needs_web: false,
        needs_rag: false
      };
    }

    if (isImagePrompt(userPrompt)) {
      return {
        intent: "image_generation",
        needs_web: false,
        needs_rag: false
      };
    }

    const promptText = buildUnifiedIntentPrompt(userPrompt, optionsArg);
    const raw = await callIntentModel(promptText);
    const parsed = extractJsonFromText(raw);

    const intent = normalizeLabel(parsed && parsed.intent, UNIFIED_INTENTS, "general");
    const needsWeb = normalizeBoolean(parsed && parsed.needs_web, intent === "web_research");
    const needsRag = normalizeBoolean(
      parsed && parsed.needs_rag,
      intent === "coding" || Boolean(optionsArg.hasScreenshot)
    );

    return {
      intent,
      needs_web: needsWeb,
      needs_rag: needsRag
    };
  }

  async function analyzeUserIntent(userPrompt) {
    const unified = await classifyIntent(userPrompt);
    const intent = unified.intent === "document_formatting" ? "generate_file" : unified.intent === "other" ? "other" : "explain";
    return {
      intent,
      confidence: 0.8
    };
  }

  async function analyzeFileTypes(userPrompt) {
    const text = String(userPrompt || "").toLowerCase();
    const outputTypes = [];
    if (text.includes("pdf")) outputTypes.push("pdf");
    if (text.includes("excel") || text.includes("xlsx") || text.includes("sheet")) outputTypes.push("excel");
    if (text.includes("docx") || text.includes("word") || text.includes("doc")) outputTypes.push("docx");
    if (text.includes("html") || text.includes("web page") || text.includes("webpage")) outputTypes.push("html");
    if (text.includes("json")) outputTypes.push("json");
    if (text.includes("image") || text.includes("poster") || text.includes("logo")) outputTypes.push("image");
    return {
      outputTypes: outputTypes.length > 0 ? Array.from(new Set(outputTypes)) : ["html"],
      confidence: 0.75
    };
  }

  async function validateFileIntent(userPrompt, intentResult) {
    const text = String(userPrompt || "").toLowerCase();
    const explicitMarkers = [
      "file",
      "download",
      "export",
      "pdf",
      "docx",
      "excel",
      "html",
      "json"
    ];
    const valid = explicitMarkers.some((marker) => text.includes(marker));
    return {
      valid,
      confidence: valid ? 0.85 : 0.55
    };
  }

  async function classifyInputType(userPrompt) {
    const unified = await classifyIntent(userPrompt);
    let type = "teaching";
    if (unified.intent === "document_formatting") {
      type = "file_generation";
    } else if (unified.intent === "coding") {
      type = "code_generation";
    }

    return {
      type,
      confidence: 0.8
    };
  }

  function mapIntentToTool(intentLabel) {
    switch (String(intentLabel || "").trim().toLowerCase()) {
      case "web_research":
        return "webSearch";
      case "coding":
        return "codeFix";
      default:
        return "";
    }
  }

  return {
    detectResponseMode,
    detectTone,
    getTone,
    isGreeting,
    isInformalLanguage,
    isImagePrompt,
    analyzeFileTypes,
    analyzeUserIntent,
    classifyIntent,
    classifyInputType,
    mapIntentToTool,
    validateFileIntent
  };
}

module.exports = { createIntentService };
