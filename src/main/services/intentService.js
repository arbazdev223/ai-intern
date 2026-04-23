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
  const PLANNER_TASKS = ["chat", "explain", "code", "image", "search", "analyze"];
  const PLANNER_SUBTASKS = ["basic", "deep", "comparison", "fix", "generate"];
  const PLANNER_TOOLS = ["web_search", "image_gen"];
  const PLANNER_LANGUAGES = ["english", "hinglish", "hinglish"];
  const PLANNER_RESPONSE_MODES = ["short", "detailed"];
  const PLANNER_FORMATS = ["auto", "table", "list", "bullets"];
  const PLANNER_IMAGE_TYPES = ["auto", "diagram", "flowchart", "comparison", "realistic"];
  const plannerMetrics = {
    total: 0,
    success: 0,
    fallback: 0,
    retries: 0
  };

  function normalizePlannerTopic(value) {
    const topic = String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!topic) {
      return "general";
    }
    return topic.slice(0, 120);
  }

  function expandEntityLabel(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) {
      return "";
    }

    const map = {
      ml: "machine learning",
      dl: "deep learning",
      ai: "artificial intelligence",
      nlp: "natural language processing",
      cv: "computer vision"
    };

    return map[raw] || raw;
  }

  function normalizeComparisonEntity(value) {
    const raw = String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!raw) {
      return "";
    }

    const cleaned = raw
      .replace(/^(difference\s+between|compare\s+|comparison\s+between|between\s+)/, "")
      .replace(/\s+(kya|hai|kaise|kyu|mein|me|difference|vs)\b.*$/, "")
      .trim();

    return expandEntityLabel(cleaned);
  }

  function extractComparisonTopicFromContext(contextText) {
    const source = String(contextText || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!source) {
      return "";
    }

    const comparisonPattern = /\b([^?.!\n]+?)\s+aur\s+([^?.!\n]+?)(?:\s+(?:kya|kaise|kyu|difference|vs|mein|me)\b|[?.!\n]|$)/i;
    const match = source.match(comparisonPattern);
    if (!match) {
      return "";
    }

    const left = normalizeComparisonEntity(match[1]);
    const right = normalizeComparisonEntity(match[2]);
    if (!left || !right) {
      return "";
    }

    return normalizePlannerTopic(`${left} vs ${right}`);
  }

  function isFollowUpShort(input) {
    const text = String(input || "").trim().toLowerCase();
    return (
      text.length < 25 &&
      (text.includes("deep") || text.includes("aur") || text.includes("more"))
    );
  }

  function inferTopicFromContext(contextText) {
    const comparisonTopic = extractComparisonTopicFromContext(contextText);
    if (comparisonTopic) {
      return comparisonTopic;
    }

    const source = String(contextText || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!source) {
      return "general";
    }
    return source.slice(0, 120);
  }

  function logPlannerMetrics() {
    const total = plannerMetrics.total;
    const successRate = total > 0 ? (plannerMetrics.success / total) * 100 : 0;
    console.info("[planner] metrics", {
      total,
      success: plannerMetrics.success,
      fallback: plannerMetrics.fallback,
      retries: plannerMetrics.retries,
      successRate: Number(successRate.toFixed(2))
    });
  }

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
      lower.includes("explain ") ||
      /\b(samjhao|samjha|samjhaao|explanation)\b/i.test(lower)
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

  function detectRequestedFormat(inputText) {
    const text = String(inputText || "").trim().toLowerCase();
    if (!text) {
      return "auto";
    }

    if (/\b(table|tabular|in\s+table\s+format)\b/.test(text)) {
      return "table";
    }
    if (/\b(bullet|bullets|bullet\s+points?)\b/.test(text)) {
      return "bullets";
    }
    if (/\b(list|in\s+list\s+format)\b/.test(text)) {
      return "list";
    }

    return "auto";
  }

  function detectRequestedImageType(inputText, topicText, subtaskValue) {
    const source = `${String(inputText || "")} ${String(topicText || "")}`.toLowerCase();
    const subtask = String(subtaskValue || "").toLowerCase();

    if (/\b(compare|comparison|difference|vs|versus)\b/.test(source) || subtask === "comparison") {
      return "comparison";
    }

    if (/\b(flow|flowchart|workflow|process|pipeline|steps?|sequence|stages?)\b/.test(source)) {
      return "flowchart";
    }

    if (/\b(photo|realistic|real\s+world|portrait|object|product|landscape|cinematic|3d)\b/.test(source)) {
      return "realistic";
    }

    if (/\b(diagram|architecture|system|framework|model|algorithm|network|ai|ml|deep\s+learning)\b/.test(source)) {
      return "diagram";
    }

    return "auto";
  }

  function normalizePlannerPlan(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    const task = normalizeLabel(value.task, PLANNER_TASKS, "chat");
    const subtask = normalizeLabel(value.subtask, PLANNER_SUBTASKS, "basic");
    const language = normalizeLabel(value.language, PLANNER_LANGUAGES, "english");
    const responseMode = normalizeLabel(value.response_mode, PLANNER_RESPONSE_MODES, "detailed");
    const format = normalizeLabel(value.format, PLANNER_FORMATS, "auto");
    const imageType = normalizeLabel(value.image_type, PLANNER_IMAGE_TYPES, "auto");
    const topic = normalizePlannerTopic(value.topic);
    const tools = Array.isArray(value.tools)
      ? Array.from(
          new Set(
            value.tools
              .map((item) => String(item || "").trim().toLowerCase())
              .filter((item) => PLANNER_TOOLS.includes(item))
          )
        )
      : [];

    return {
      task,
      subtask,
      tools,
      topic,
      language,
      response_mode: responseMode,
      format,
      image_type: imageType
    };
  }

  function enforcePlannerGuards(userInput, contextText, plan) {
    if (!plan) {
      return null;
    }

    const input = String(userInput || "").trim().toLowerCase();
    const words = input ? input.split(/\s+/).filter(Boolean) : [];
    const simpleFactPattern = /\b(what|who|when|where)\b/.test(input) || /\d/.test(input);
    const hasRecencySignal = /\b(current|currently|today|now|latest|recent|202\d)\b/.test(input);
    const hasExplicitSearchSignal = /\b(search|find|lookup|news|update|headline)\b/.test(input);
    const followUpDeepPattern = /\b(explain\s+more|deep\s+explain|deep\s+karo|aur\s+detail|detail\s+me|aur\s+samjhao|thoda\s+aur)\b/.test(input);
    const followUpShort = isFollowUpShort(input);
    const detectedFormat = detectRequestedFormat(input);
    // Don't force "short" for actual questions; users often ask short questions but expect full explanations.
    const hasQuestionSignal =
      /\?/.test(input) ||
      /\b(what|why|how|who|when|where|which)\b/.test(input) ||
      /\b(kya|kaise|kyu|kyon|kab|kahan|kaun|kis|kon)\b/.test(input);
    const asksForDetail =
      /\b(detail|details|detail\s+me|explain|samjhao|elaborate|step\s*by\s*step)\b/.test(input);

    const shouldBeShort =
      !hasQuestionSignal &&
      !asksForDetail &&
      !hasRecencySignal &&
      !hasExplicitSearchSignal &&
      (words.length <= 4 || simpleFactPattern);
    const contextTopic = inferTopicFromContext(contextText);
    const comparisonContextTopic = extractComparisonTopicFromContext(contextText);

    const next = { ...plan };

    if (shouldBeShort) {
      next.response_mode = "short";
    }

    if (next.task === "explain" && simpleFactPattern) {
      next.task = "chat";
    }

    if (next.task === "image" && !next.tools.includes("image_gen")) {
      next.tools = [...next.tools, "image_gen"];
    }

    if (next.task === "search" && !next.tools.includes("web_search")) {
      next.tools = [...next.tools, "web_search"];
    }

    if (next.task === "search" && simpleFactPattern && !hasRecencySignal && !hasExplicitSearchSignal) {
      next.task = "chat";
      next.tools = next.tools.filter((tool) => tool !== "web_search");
    }

    if ((!next.topic || next.topic === "general") && contextTopic !== "general") {
      next.topic = contextTopic;
    }

    if (followUpDeepPattern) {
      next.task = "explain";
      if (next.subtask === "basic") {
        next.subtask = "deep";
      }
      next.response_mode = "detailed";
      if ((!next.topic || next.topic === "general") && contextTopic !== "general") {
        next.topic = contextTopic;
      }
    }

    if (followUpShort && comparisonContextTopic) {
      next.task = "explain";
      next.subtask = "comparison";
      next.topic = comparisonContextTopic;
      next.response_mode = "detailed";
    }

    if (followUpShort && !comparisonContextTopic && contextTopic !== "general") {
      next.topic = contextTopic;
    }

    // Format must be derived only from current input; never carry from previous turns.
    next.format = detectedFormat;

    if (next.task === "image") {
      const detectedImageType = detectRequestedImageType(input, next.topic, next.subtask);
      if (!next.image_type || next.image_type === "auto") {
        next.image_type = detectedImageType;
      }
      if (!next.image_type || next.image_type === "auto") {
        next.image_type = "diagram";
      }
    }

    console.log("FINAL TOPIC:", next.topic);

    return next;
  }

  async function planUserIntent(inputArg) {
    const payload = inputArg && typeof inputArg === "object" ? inputArg : { input: inputArg, context: "" };
    const userInput = String(payload.input || "").trim();
    const previousContext = String(payload.context || "").trim();
    if (!userInput) {
      return null;
    }

    const prompt = [
      "You are a planner AI.",
      "Analyze the user input and return only valid JSON.",
      "You MUST return ONLY valid JSON. No text outside JSON.",
      "",
      "{",
      '  "task": "chat | explain | code | image | search | analyze",',
      '  "subtask": "basic | deep | comparison | fix | generate",',
      '  "tools": ["web_search" | "image_gen"],',
      '  "topic": "main topic",',
      '  "language": "english | hinglish | hinglish",',
      '  "response_mode": "short | detailed",',
      '  "format": "auto | table | list | bullets",',
      '  "image_type": "auto | diagram | flowchart | comparison | realistic"',
      "}",
      "",
      "Rules:",
      "- Return JSON only, no extra text.",
      "- Use only allowed enum values exactly as listed.",
      "- If user asks for image generation/editing: task=image and include tools=[\"image_gen\"].",
      "- If user asks for latest/current/live information: task=search and include tools=[\"web_search\"].",
      "- If user asks for concepts: task=explain.",
      "- If user asks coding/debugging/programming: task=code.",
      "- If task=image, classify image_type using user intent (diagram/flowchart/comparison/realistic).",
      "- For greetings or very short casual prompts, use response_mode=short.",
      "- If user requests a format (table, list, bullets), you MUST strictly follow it.",
      "- If user asks in table format, set format=table.",
      "- If current input is a short follow-up (for example: explain more, deep karo), use previous context to keep same topic.",
      "- If the current input is vague (like 'explain more', 'deep karo'), you MUST use the FULL previous context topic.",
      "- Do NOT reduce it to a subset.",
      "- Do NOT pick only one part.",
      "- Use the complete subject.",
      "",
      "Examples:",
      'User: "hi" -> {"task":"chat","subtask":"basic","tools":[],"language":"english","response_mode":"short"}',
      'User: "ML kya hai" -> {"task":"explain","subtask":"basic","tools":[],"language":"hinglish","response_mode":"detailed"}',
      'User: "fix this code" -> {"task":"code","subtask":"fix","tools":[],"language":"english","response_mode":"detailed"}',
      'User: "difference between ML and DL in table format" -> {"task":"explain","subtask":"comparison","tools":[],"topic":"machine learning vs deep learning","language":"english","response_mode":"detailed","format":"table"}',
      'User: "ML aur DL kya hai" then next input "deep explain karo" -> {"task":"explain","subtask":"comparison","tools":[],"topic":"machine learning vs deep learning","language":"hinglish","response_mode":"detailed"}',
      'Wrong for above follow-up -> {"task":"explain","subtask":"comparison","tools":[],"topic":"deep learning","language":"hinglish","response_mode":"detailed"}',
      "",
      "Previous context:",
      previousContext || "(none)",
      "",
      "User input:",
      userInput
    ].join("\n");

    const retryPrompt = [
      prompt,
      "",
      "Reminder:",
      "Return ONLY valid JSON and strictly follow enum constraints."
    ].join("\n");

    plannerMetrics.total += 1;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const raw = await callIntentModel(attempt === 0 ? prompt : retryPrompt);
      const parsed = extractJsonFromText(raw);
      const normalized = enforcePlannerGuards(userInput, previousContext, normalizePlannerPlan(parsed));
      if (normalized) {
        const requestedFormat = detectRequestedFormat(userInput);
        // Strictly pin format to current input every request.
        normalized.format = requestedFormat;
        if (normalized.task === "image") {
          const requestedImageType = detectRequestedImageType(userInput, normalized.topic, normalized.subtask);
          if (!normalized.image_type || normalized.image_type === "auto") {
            normalized.image_type = requestedImageType === "auto" ? "diagram" : requestedImageType;
          }
        }
        plannerMetrics.success += 1;
        if (attempt > 0) {
          plannerMetrics.retries += 1;
        }
        logPlannerMetrics();
        return normalized;
      }
    }

    plannerMetrics.fallback += 1;
    logPlannerMetrics();
    return null;
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
    if (/^(hi+|hey+|hello+|hii+|hlo+|yo+)$/.test(text)) {
      return true;
    }

    // Hinglish/typo-friendly greeting phrases.
    const greetingPhrases = [
      /\b(kya\s+haal|kya\s+hal|kya\s+haal\s+hai|kya\s+hal\s+hai)\b/,
      /\b(kaise\s+ho|kaise\s+ho\s+tum)\b/,
      /\b(sab\s+theek|sab\s+thik|sab\s+thik\s+hai|sab\s+theek\s+hai)\b/,
      /\b(aur\s+batao|aur\s+sunao)\b/
    ];

    return greetingPhrases.some((pattern) => pattern.test(text));
  }

  function normalize(text) {
    return String(text || "").toLowerCase().trim();
  }

  function hasConcreteTaskSignals(text) {
    const t = normalize(text);
    if (!t) {
      return false;
    }

    const taskPatterns = [
      /\b(error|issue|problem|fix|debug|code|function|api|query|bug)\b/,
      /\b(pdf|docx?|excel|sheet|html|json|file|download|export)\b/,
      /\b(price|rate|gst|tax|gold|stock|salary|invoice|amount)\b/,
      /\b(latest|news|update|search|headline|current)\b/,
      /\b(what|who|when|where|why|how\s+to)\b/,
      /https?:\/\//,
      /[%$€₹]/,
      /\d/
    ];

    return taskPatterns.some((pattern) => pattern.test(t));
  }

  function getSignals(text) {
    const t = normalize(text);
    const words = t ? t.split(/\s+/).filter(Boolean) : [];
    const greetingLike = isGreeting(t);
    const concreteTaskSignals = hasConcreteTaskSignals(t);

    return {
      wordCount: words.length,
      hasQuestion: /\?/.test(t),
      hasVerb: /\b(kar|kya|kaise|bata|help|explain|tell|guide|discuss)\b/i.test(t),
      hasConcreteTaskSignals: concreteTaskSignals,
      isShort: t.length <= 12,
      isSingleWord: words.length === 1,
      isGreetingPattern: greetingLike || /^(hi+|hello+|hey+|hlo+|yo+)$/.test(t)
    };
  }

  function classifyIntent(text) {
    const s = getSignals(text);

    if (s.isGreetingPattern || (s.isSingleWord && s.isShort)) {
      return "greeting";
    }

    // Scalable small-talk rule: short messages without concrete task signals stay casual.
    if (!s.hasConcreteTaskSignals && s.wordCount <= 8) {
      return "casual";
    }

    if (s.hasVerb || s.wordCount >= 3 || s.hasQuestion) {
      return "meaningful";
    }

    return "casual";
  }

  function detectLanguage(text) {
    const source = String(text || "").trim();
    if (/[\u0900-\u097F]/.test(source)) return "hinglish";
    const ratioHindiWords = (source.match(/(kya|hai|kar|tum|mujhe|kaise|bata)/gi) || []).length;
    if (ratioHindiWords >= 1) return "hinglish";
    return "english";
  }

  function isCasualInput(text) {
    const intent = classifyIntent(text);
    return intent === "casual" || intent === "greeting";
  }

  function detectTone(input) {
    const text = normalize(input);
    const intent = classifyIntent(text);

    if (isExplanationRequest(text)) return "formal";
    if (intent === "greeting" || intent === "casual") return "casual";
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

  async function classifyTaskIntent(userPrompt, optionsArg = {}) {
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
    const unified = await classifyTaskIntent(userPrompt);
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
    const unified = await classifyTaskIntent(userPrompt);
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
    normalize,
    getSignals,
    classifyIntent,
    classifyTaskIntent,
    detectTone,
    detectLanguage,
    getTone,
    isCasualInput,
    isGreeting,
    isInformalLanguage,
    isImagePrompt,
    analyzeFileTypes,
    analyzeUserIntent,
    classifyIntent,
    classifyInputType,
    mapIntentToTool,
    planUserIntent,
    validateFileIntent
  };
}

module.exports = { createIntentService };
